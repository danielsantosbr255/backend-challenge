import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import {
  CreateQueueCommand,
  DeleteQueueCommand,
  GetQueueAttributesCommand,
  SendMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { MikroORM } from '@mikro-orm/core';
import { Migrator } from '@mikro-orm/migrations';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { Module, ValidationPipe, type INestApplication } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_FILTER, NestFactory } from '@nestjs/core';
import { delay } from '@/common/async/retry';
import { MetricsService } from '@/common/observability/metrics.service';
import { validateEnv } from '@/infrastructure/config/env.schema';
import { GlobalHttpExceptionFilter } from '@/infrastructure/http/global-http-exception.filter';
import { SqsModule } from '@/infrastructure/messaging/sqs.module';
import { mikroOrmConfig } from '@/infrastructure/persistence/mikro-orm.config';
import { WalletModule } from '@/modules/wallet/wallet.module';
import { WagerModule } from '@/modules/wager/wager.module';
import { WagerSqsConsumer } from '@/modules/wager/wager-sqs-consumer';
import { withBlockedOutbox } from './helpers/blocked-outbox';

const runId = crypto.randomUUID();
const queueName = `wager-retry-test-${runId}.fifo`;
const dlqName = `wager-retry-test-dlq-${runId}.fifo`;
const sqs = new SQSClient({
  region: 'us-east-1',
  endpoint: 'http://localhost:4566',
  credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
});
let queueUrl: string;
let dlqUrl: string;
let app: INestApplication;
let orm: MikroORM;
let baseUrl: string;

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      ignoreEnvFile: true,
      skipProcessEnv: true,
      load: [() => validateEnv({
        ...process.env,
        SQS_QUEUE_URL: queueUrl,
        SQS_DLQ_URL: dlqUrl,
        SQS_EVENTS_QUEUE_URL: `http://localhost:4566/000000000000/wager-events.fifo`,
      })],
    }),
    MikroOrmModule.forRoot({ ...mikroOrmConfig, extensions: [Migrator] }),
    WalletModule,
    WagerModule,
    SqsModule,
  ],
  providers: [
    WagerSqsConsumer,
    { provide: APP_FILTER, useClass: GlobalHttpExceptionFilter },
  ],
})
class WagerSqsRetryTestModule {}

describe('SQS transient retry (PostgreSQL and LocalStack)', () => {
  beforeAll(async () => {
    const dlq = await sqs.send(new CreateQueueCommand({
      QueueName: dlqName, Attributes: { FifoQueue: 'true', ContentBasedDeduplication: 'false' },
    }));
    if (dlq.QueueUrl === undefined) throw new Error('LocalStack did not return the DLQ URL');
    dlqUrl = dlq.QueueUrl;
    const attributes = await sqs.send(new GetQueueAttributesCommand({ QueueUrl: dlqUrl, AttributeNames: ['QueueArn'] }));
    const dlqArn = attributes.Attributes?.['QueueArn'];
    if (dlqArn === undefined) throw new Error('LocalStack did not return the DLQ ARN');
    const queue = await sqs.send(new CreateQueueCommand({
      QueueName: queueName,
      Attributes: {
        FifoQueue: 'true', ContentBasedDeduplication: 'false',
        RedrivePolicy: JSON.stringify({ deadLetterTargetArn: dlqArn, maxReceiveCount: '3' }),
      },
    }));
    if (queue.QueueUrl === undefined) throw new Error('LocalStack did not return the queue URL');
    queueUrl = queue.QueueUrl;
    app = await NestFactory.create(WagerSqsRetryTestModule, { logger: false });
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    orm = app.get(MikroORM);
    await orm.migrator.up();
    await app.listen(0, '127.0.0.1');
    baseUrl = await app.getUrl();
  }, 30_000);

  afterAll(async () => {
    await app?.close();
    if (queueUrl !== undefined) await sqs.send(new DeleteQueueCommand({ QueueUrl: queueUrl }));
    if (dlqUrl !== undefined) await sqs.send(new DeleteQueueCommand({ QueueUrl: dlqUrl }));
    sqs.destroy();
  }, 30_000);

  it('retries a real database timeout and commits the inbox and debit only after recovery', async () => {
    const playerId = crypto.randomUUID();
    const created = await fetch(`${baseUrl}/wallets`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ playerId, initialBalance: { amount: '100.00', currency: 'BRL' } }),
    });
    const wallet: unknown = await created.json();
    if (!isJsonObject(wallet) || typeof wallet['id'] !== 'string') throw new Error('Wallet response has no id');
    const walletId = wallet['id'];
    const providerId = `provider-${runId}`;
    const externalTransactionId = `transaction-${runId}`;
    const messageId = `message-${runId}`;
    await withBlockedOutbox(orm, providerId, externalTransactionId, async () => {
      await sqs.send(new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageGroupId: walletId,
        MessageDeduplicationId: messageId,
        MessageBody: JSON.stringify({
          messageId,
          type: 'WagerTransactionRequested',
          occurredAt: new Date().toISOString(),
          data: {
            providerId,
            externalTransactionId,
            idempotencyKey: `key-${runId}`,
            playerId,
            walletId,
            roundId: `round-${runId}`,
            gameId: 'retry-test',
            kind: 'BET',
            money: { amount: '10.00', currency: 'BRL' },
          },
        }),
      }));
      await waitUntil(async () => (await app.get(MetricsService).metrics()).includes('wager_retries_total{area="sqs"}'), 5_000);
      const state = await orm.em.getConnection().execute<Array<{ balance: string; wagers: number; inbox: number; outbox: number }>>(
        `SELECT w.balance,
          (SELECT count(*)::int FROM wager_transactions WHERE provider_id = ?) AS wagers,
          (SELECT count(*)::int FROM inbox_messages WHERE consumer_name = 'wager-transactions-v1' AND message_id = ?) AS inbox,
          (SELECT count(*)::int FROM outbox_messages WHERE aggregate_id = ?) AS outbox
         FROM wallets w WHERE w.id = ?`,
        [providerId, messageId, walletId, walletId],
      );
      expect(state[0]).toEqual({ balance: '100.00', wagers: 0, inbox: 0, outbox: 2 });
      expect(await queueSize(dlqUrl)).toBe(0);
    });

    await waitUntil(async () => {
      const response = await fetch(`${baseUrl}/providers/${providerId}/wagering/transactions/${externalTransactionId}`);
      if (response.status !== 200) return false;
      const body: unknown = await response.json();
      return isJsonObject(body) && body['status'] === 'PROCESSED';
    }, 10_000);
    await waitUntil(async () => await queueSize(queueUrl) === 0, 5_000);
    expect(await queueSize(dlqUrl)).toBe(0);
    const ledger = await fetch(`${baseUrl}/wallets/${walletId}/ledger`);
    expect(await ledger.json()).toMatchObject({ entries: [{ direction: 'DEBIT' }, { direction: 'CREDIT' }] });
    const reconciliation = await fetch(`${baseUrl}/wallets/${walletId}/reconciliation`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ walletId }),
    });
    expect(await reconciliation.json()).toMatchObject({
      storedBalance: { amount: '90.00', currency: 'BRL' }, calculatedBalance: { amount: '90.00', currency: 'BRL' }, consistent: true,
    });
    const rows = await orm.em.getConnection().execute<Array<{ inbox: number; wagers: number; outbox: number }>>(
      `SELECT
        (SELECT count(*)::int FROM inbox_messages WHERE consumer_name = 'wager-transactions-v1' AND message_id = ?) AS inbox,
        (SELECT count(*)::int FROM wager_transactions WHERE provider_id = ?) AS wagers,
        (SELECT count(*)::int FROM outbox_messages WHERE aggregate_id = ?) AS outbox`,
      [messageId, providerId, walletId],
    );
    expect(rows[0]).toEqual({ inbox: 1, wagers: 1, outbox: 4 });
  }, 20_000);

  it('redrives an exhausted transient database failure to the DLQ without financial effects', async () => {
    const playerId = crypto.randomUUID();
    const created = await fetch(`${baseUrl}/wallets`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ playerId, initialBalance: { amount: '100.00', currency: 'BRL' } }),
    });
    const wallet: unknown = await created.json();
    if (!isJsonObject(wallet) || typeof wallet['id'] !== 'string') throw new Error('Wallet response has no id');
    const walletId = wallet['id'];
    const providerId = `exhausted-${runId}`;
    const messageId = `exhausted-message-${runId}`;
    await withBlockedOutbox(orm, providerId, messageId, async () => {
      await sqs.send(new SendMessageCommand({
        QueueUrl: queueUrl, MessageGroupId: walletId, MessageDeduplicationId: messageId,
        MessageBody: JSON.stringify({ messageId, type: 'WagerTransactionRequested', occurredAt: new Date().toISOString(),
          data: { providerId, externalTransactionId: messageId, idempotencyKey: messageId, playerId, walletId,
            roundId: 'exhausted-round', gameId: 'retry-test', kind: 'BET', money: { amount: '10.00', currency: 'BRL' } } }),
      }));
      await waitUntil(async () => await queueSize(dlqUrl) === 1, 15_000);
      await waitUntil(async () => (await app.get(MetricsService).metrics()).includes('wager_dlq_messages 1'), 15_000);
      const rows = await orm.em.getConnection().execute<Array<{ wagers: number; inbox: number }>>(
        `SELECT (SELECT count(*)::int FROM wager_transactions WHERE provider_id = ?) AS wagers,
                (SELECT count(*)::int FROM inbox_messages WHERE message_id = ?) AS inbox`, [providerId, messageId],
      );
      expect(rows[0]).toEqual({ wagers: 0, inbox: 0 });
    });
    const reconciliation = await fetch(`${baseUrl}/wallets/${walletId}/reconciliation`, { method: 'POST' });
    expect(await reconciliation.json()).toMatchObject({ consistent: true, storedBalance: { amount: '100.00' } });
  }, 40_000);
});

async function queueSize(url: string): Promise<number> {
  const attributes = await sqs.send(new GetQueueAttributesCommand({
    QueueUrl: url, AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'],
  }));
  return Number(attributes.Attributes?.['ApproximateNumberOfMessages'] ?? '-1') +
    Number(attributes.Attributes?.['ApproximateNumberOfMessagesNotVisible'] ?? '-1');
}

async function waitUntil(check: () => Promise<boolean>, timeoutMilliseconds: number): Promise<void> {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(100);
  }
  throw new Error('Expected recovery condition was not observed');
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

