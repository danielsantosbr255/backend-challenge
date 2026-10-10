import {
  SendMessageCommand,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import { EntityManager } from '@mikro-orm/core';
import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { MetricsService } from '@/common/observability/metrics.service';
import { ConfigService } from '@nestjs/config';
import { v7 as uuidv7 } from 'uuid';
import { delay, exponentialBackoffSeconds } from '@/common/async/retry';
import { SQS_CLIENT } from '@/infrastructure/messaging/sqs-client.provider';

interface ClaimedOutboxMessage {
  id: string;
  aggregate_id: string;
  payload: Record<string, unknown>;
  attempts: number;
}

@Injectable()
export class OutboxPublisher implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OutboxPublisher.name);
  private readonly queueUrl: string;
  private readonly ownerId = uuidv7();
  private running = false;
  private loop: Promise<void> | undefined;

  constructor(
    @Inject(EntityManager) private readonly em: EntityManager,
    @Inject(SQS_CLIENT) private readonly sqs: SQSClient,
    config: ConfigService,
    private readonly metrics: MetricsService,
  ) {
    this.queueUrl = config.getOrThrow<string>('SQS_EVENTS_QUEUE_URL');
  }

  onModuleInit(): void {
    this.running = true;
    this.loop = this.publishLoop();
  }

  async onModuleDestroy(): Promise<void> {
    this.running = false;
    await this.loop;
  }

  private async publishLoop(): Promise<void> {
    while (this.running) {
      try {
        const batch = await this.claimBatch();
        if (batch.length === 0) {
          await delay(1000);
          continue;
        }
        for (const event of batch) {
          if (!this.running) break;
          await this.publish(event);
        }
      } catch (error: unknown) {
        this.logger.error(JSON.stringify({
          event: 'outbox_poll_retry',
          errorType: error instanceof Error ? error.name : 'UnknownError',
        }));
        await delay(1000);
      }
    }
  }

  private async claimBatch(): Promise<ClaimedOutboxMessage[]> {
    const lag = await this.em.getConnection().execute<Array<{ lag_seconds: number | null }>>(
      `SELECT EXTRACT(EPOCH FROM (current_timestamp - MIN(occurred_at)))::float8 AS lag_seconds
       FROM outbox_messages WHERE published_at IS NULL`,
    );
    this.metrics.setOutboxLag(lag[0]?.lag_seconds ?? 0);
    return this.em.transactional(async (em) => em.getConnection().execute<ClaimedOutboxMessage[]>(
      `WITH candidates AS (
         SELECT id FROM outbox_messages
         WHERE published_at IS NULL AND next_attempt_at <= current_timestamp
           AND (claimed_until IS NULL OR claimed_until < current_timestamp)
         ORDER BY occurred_at, id
         FOR UPDATE SKIP LOCKED
         LIMIT 1
       )
       UPDATE outbox_messages AS messages
       SET claimed_by = ?, claimed_until = current_timestamp + interval '60 seconds',
           attempts = messages.attempts + 1
       FROM candidates
       WHERE messages.id = candidates.id
       RETURNING messages.id, messages.aggregate_id, messages.payload, messages.attempts`,
      [this.ownerId], 'all', em.getTransactionContext(),
    ));
  }

  private async publish(event: ClaimedOutboxMessage): Promise<void> {
    try {
      await this.sqs.send(new SendMessageCommand({
        QueueUrl: this.queueUrl,
        MessageBody: JSON.stringify(event.payload),
        MessageGroupId: event.aggregate_id,
        MessageDeduplicationId: event.id,
      }));
      await this.em.getConnection().execute(
        `UPDATE outbox_messages
         SET published_at = current_timestamp, claimed_by = NULL, claimed_until = NULL
         WHERE id = ? AND claimed_by = ? AND published_at IS NULL`,
        [event.id, this.ownerId],
      );
    } catch (error: unknown) {
      this.metrics.recordRetry('outbox');
      const retrySeconds = exponentialBackoffSeconds(event.attempts + 1, 300);
      await this.em.getConnection().execute(
        `UPDATE outbox_messages
         SET next_attempt_at = current_timestamp + (? * interval '1 second'),
             claimed_by = NULL, claimed_until = NULL
         WHERE id = ? AND claimed_by = ? AND published_at IS NULL`,
        [retrySeconds, event.id, this.ownerId],
      );
      this.logger.error(JSON.stringify({
        event: 'outbox_publish_retry',
        ...outboxLogContext(event),
        errorType: error instanceof Error ? error.name : 'UnknownError',
      }));
    }
  }
}

function outboxLogContext(event: ClaimedOutboxMessage): {
  messageId: string;
  transactionId: string;
  walletId: string;
  providerId: string;
  correlationId: string;
} {
  const data = event.payload['data'];
  return {
    messageId: event.id,
    transactionId: readEventField(data, 'transactionId') ?? event.id,
    walletId: event.aggregate_id,
    providerId: readEventField(data, 'providerId') ?? 'unknown',
    correlationId: readEventField(event.payload, 'correlationId') ?? 'unknown',
  };
}

function readEventField(value: unknown, field: string): string | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const result = Reflect.get(value, field);
  return typeof result === 'string' ? result : undefined;
}
