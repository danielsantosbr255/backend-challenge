import {
  GetQueueAttributesCommand,
  QueueAttributeName,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { EntityManager } from '@mikro-orm/core';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SQS_CLIENT } from '@/infrastructure/messaging/sqs-client.provider';

type HealthDependency = 'database' | 'sqs';
type DependencyStatus = 'up' | 'down';

export interface ReadinessResult {
  isReady: boolean;
  details: Record<HealthDependency, DependencyStatus>;
  errors?: Partial<Record<HealthDependency, 'unavailable'>>;
}

@Injectable()
export class HealthService {
  private readonly logger = new Logger(HealthService.name);

  constructor(
    private readonly entityManager: EntityManager,
    @Inject(SQS_CLIENT) private readonly sqsClient: SQSClient,
    private readonly configService: ConfigService,
  ) {}

  async checkReadiness(): Promise<ReadinessResult> {
    const [databaseIsAvailable, sqsIsAvailable] = await Promise.all([
      this.isAvailable('PostgreSQL', async () => {
        await this.entityManager.getConnection().execute('SELECT 1');
      }),
      this.isAvailable('SQS', () => this.checkSqs()),
    ]);

    const details: ReadinessResult['details'] = {
      database: databaseIsAvailable ? 'up' : 'down',
      sqs: sqsIsAvailable ? 'up' : 'down',
    };
    const errors: NonNullable<ReadinessResult['errors']> = {};

    if (!databaseIsAvailable) {
      errors.database = 'unavailable';
    }

    if (!sqsIsAvailable) {
      errors.sqs = 'unavailable';
    }

    return {
      isReady: databaseIsAvailable && sqsIsAvailable,
      details,
      ...(Object.keys(errors).length > 0 ? { errors } : {}),
    };
  }

  private async isAvailable(name: string, check: () => Promise<void>): Promise<boolean> {
    try {
      await check();
      return true;
    } catch (error: unknown) {
      const errorType = error instanceof Error ? error.name : 'UnknownError';
      this.logger.error(`${name} readiness check failed (${errorType})`);
      return false;
    }
  }

  private async checkSqs(): Promise<void> {
    const queueUrl = this.configService.getOrThrow<string>('SQS_QUEUE_URL');
    const deadLetterQueueUrl = this.configService.getOrThrow<string>('SQS_DLQ_URL');
    const eventsQueueUrl = this.configService.getOrThrow<string>('SQS_EVENTS_QUEUE_URL');

    await Promise.all(
      [queueUrl, deadLetterQueueUrl, eventsQueueUrl].map((url) =>
        this.sqsClient.send(
          new GetQueueAttributesCommand({
            QueueUrl: url,
            AttributeNames: [QueueAttributeName.QueueArn],
          }),
        ),
      ),
    );
  }
}
