import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import {
  CreateQueueCommand,
  DeleteQueueCommand,
  GetQueueAttributesCommand,
  SendMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { Module, type INestApplication } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { delay } from '@/common/async/retry';
import { MetricsModule } from '@/common/observability/metrics.module';
import type { ProcessWagerResponseDto } from '@/modules/wager/dtos/process-wager-response.dto';
import { ProcessWagerUseCase } from '@/modules/wager/use-cases/process-wager.use-case';
import { WagerSqsConsumer } from '@/modules/wager/wager-sqs-consumer';
import { SQS_CLIENT } from '@/infrastructure/messaging/sqs-client.provider';
import { TransientInfrastructureError } from '@/common/errors/transient-infrastructure.error';

const runId = crypto.randomUUID();
const queueName = `wager-retry-test-${runId}`;
const dlqName = `wager-retry-test-dlq-${runId}`;
const sqs = new SQSClient({
  region: 'us-east-1',
  endpoint: 'http://localhost:4566',
  credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
});
let queueUrl: string;
let dlqUrl: string;
let app: INestApplication;
let processAttempts = 0;

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      ignoreEnvFile: true,
      load: [() => ({ SQS_QUEUE_URL: queueUrl, SQS_DLQ_URL: dlqUrl })],
    }),
    MetricsModule,
  ],
  providers: [
    WagerSqsConsumer,
    { provide: SQS_CLIENT, useValue: sqs },
    {
      provide: ProcessWagerUseCase,
      useValue: {
        execute: async (): Promise<ProcessWagerResponseDto> => {
          processAttempts += 1;
          if (processAttempts === 1) throw new TransientInfrastructureError();
          return {
            transactionId: crypto.randomUUID(),
            status: 'PROCESSED',
            balance: { amount: '10.00', currency: 'BRL' },
            idempotentReplay: false,
          };
        },
      },
    },
  ],
})
class WagerSqsRetryTestModule {}

describe('SQS transient retry (LocalStack)', () => {
  beforeAll(async () => {
    const queue = await sqs.send(new CreateQueueCommand({ QueueName: queueName }));
    const dlq = await sqs.send(new CreateQueueCommand({ QueueName: dlqName }));
    if (queue.QueueUrl === undefined || dlq.QueueUrl === undefined) {
      throw new Error('LocalStack did not return the queue URLs');
    }
    queueUrl = queue.QueueUrl;
    dlqUrl = dlq.QueueUrl;
    processAttempts = 0;
    app = await NestFactory.create(WagerSqsRetryTestModule, { logger: false });
    await app.listen(0, '127.0.0.1');
  }, 30_000);

  afterAll(async () => {
    await app?.close();
    if (queueUrl !== undefined) await sqs.send(new DeleteQueueCommand({ QueueUrl: queueUrl }));
    if (dlqUrl !== undefined) await sqs.send(new DeleteQueueCommand({ QueueUrl: dlqUrl }));
    sqs.destroy();
  }, 30_000);

  it('makes the message visible for retry after a transient processing failure', async () => {
    const messageId = `message-${runId}`;
    await sqs.send(new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: JSON.stringify({
        messageId,
        type: 'WagerTransactionRequested',
        occurredAt: new Date().toISOString(),
        data: {
          providerId: `provider-${runId}`,
          externalTransactionId: `transaction-${runId}`,
          idempotencyKey: `key-${runId}`,
          playerId: crypto.randomUUID(),
          walletId: crypto.randomUUID(),
          roundId: `round-${runId}`,
          gameId: 'retry-test',
          kind: 'BET',
          money: { amount: '10.00', currency: 'BRL' },
        },
      }),
    }));

    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && processAttempts < 2) await delay(100);

    expect(processAttempts).toBe(2);
    const result = await sqs.send(new GetQueueAttributesCommand({
      QueueUrl: queueUrl,
      AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'],
    }));
    expect(Number(result.Attributes?.['ApproximateNumberOfMessages'] ?? '-1')).toBe(0);
    expect(Number(result.Attributes?.['ApproximateNumberOfMessagesNotVisible'] ?? '-1')).toBe(0);
  }, 15_000);
});

