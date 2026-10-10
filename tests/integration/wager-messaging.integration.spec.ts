import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import {
  CreateQueueCommand,
  DeleteQueueCommand,
  DeleteMessageCommand,
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { Module, type INestApplication } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { MikroORM } from '@mikro-orm/core';
import { Migrator } from '@mikro-orm/migrations';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { NestFactory } from '@nestjs/core';
import { v7 as uuidv7 } from 'uuid';
import { Money } from '@/modules/wallet/domain/money';
import { mikroOrmConfig } from '@/infrastructure/persistence/mikro-orm.config';
import { ProcessWagerUseCase } from '@/modules/wager/use-cases/process-wager.use-case';
import { PersistenceModule } from '@/infrastructure/persistence/persistence.module';
import { WalletModule } from '@/modules/wallet/wallet.module';
import { WagerModule } from '@/modules/wager/wager.module';
import { WagerWorkersModule } from '@/modules/wager/wager-workers.module';
import { HealthController } from '@/modules/health/health.controller';
import { HealthService } from '@/modules/health/health.service';
import { MetricsController } from '@/modules/health/metrics.controller';
import { SqsModule } from '@/infrastructure/messaging/sqs.module';
import { MetricsModule } from '@/common/observability/metrics.module';
import { validateEnv } from '@/infrastructure/config/env.schema';

const runId = crypto.randomUUID();
const ingressQueueName = `wager-transactions-test-${runId}.fifo`;
let ingressQueueUrl = `http://localhost:4566/000000000000/${ingressQueueName}`;
const eventsQueueName = `wager-events-test-${runId}.fifo`;
let eventsQueueUrl = `http://localhost:4566/000000000000/${eventsQueueName}`;
const eventsQueue = new SQSClient({
  region: 'us-east-1',
  endpoint: 'http://localhost:4566',
  credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
});

let app: INestApplication;
let secondPublisherApp: INestApplication | undefined;
let orm: MikroORM;
let ingressQueueCreated = false;
let eventsCreated = false;

@Module({ imports: [MikroOrmModule.forRoot({ ...mikroOrmConfig, extensions: [Migrator] })] })
class OutboxMaintenanceModule {}

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      ignoreEnvFile: true,
      skipProcessEnv: true,
      validate: (config) => validateEnv({
        ...config,
        SQS_QUEUE_URL: ingressQueueUrl,
        SQS_EVENTS_QUEUE_URL: eventsQueueUrl,
      }),
    }),
    PersistenceModule,
    WalletModule,
    WagerModule,
    WagerWorkersModule,
    SqsModule,
    MetricsModule,
  ],
  controllers: [HealthController, MetricsController],
  providers: [HealthService],
})
class WagerMessagingIntegrationModule {}

describe('SQS consumer and outbox integration (LocalStack)', () => {
  beforeAll(async () => {
    const ingressCreated = await eventsQueue.send(new CreateQueueCommand({
      QueueName: ingressQueueName,
      Attributes: { FifoQueue: 'true', ContentBasedDeduplication: 'false' },
    }));
    if (ingressCreated.QueueUrl === undefined) throw new Error('LocalStack did not return the ingress queue URL');
    ingressQueueUrl = ingressCreated.QueueUrl;
    ingressQueueCreated = true;
    const created = await eventsQueue.send(new CreateQueueCommand({
      QueueName: eventsQueueName,
      Attributes: { FifoQueue: 'true', ContentBasedDeduplication: 'false' },
    }));
    if (created.QueueUrl === undefined) throw new Error('LocalStack did not return the events queue URL');
    eventsQueueUrl = created.QueueUrl;
    eventsCreated = true;
    app = await NestFactory.create(WagerMessagingIntegrationModule, { logger: false });
    orm = app.get(MikroORM);
    await orm.migrator.up();
    await app.listen(0, '127.0.0.1');
    secondPublisherApp = await NestFactory.create(WagerMessagingIntegrationModule, { logger: false });
    await secondPublisherApp.listen(0, '127.0.0.1');
  }, 30_000);

  afterAll(async () => {
    await app?.close();
    await secondPublisherApp?.close();
    if (ingressQueueCreated) await eventsQueue.send(new DeleteQueueCommand({ QueueUrl: ingressQueueUrl }));
    if (eventsCreated) await eventsQueue.send(new DeleteQueueCommand({ QueueUrl: eventsQueueUrl }));
    eventsQueue.destroy();
  }, 30_000);

  it('recovers a post-commit unacked delivery and publishes the stable outbox event to SQS', async () => {
    const baseUrl = await app.getUrl();
    const playerId = crypto.randomUUID();
    const walletResponse = await fetch(`${baseUrl}/wallets`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ playerId, initialBalance: { amount: '100.00', currency: 'BRL' } }),
    });
    const walletBody: unknown = await walletResponse.json();
    if (!isJsonObject(walletBody) || typeof walletBody['id'] !== 'string') throw new Error('Wallet response has no id');
    const walletId = walletBody['id'];
    const wagerMessageId = `message-${runId}`;
    const externalTransactionId = `external-${runId}`;
    const messageBody = JSON.stringify({
      messageId: wagerMessageId,
      type: 'WagerTransactionRequested',
      occurredAt: new Date().toISOString(),
      data: {
        providerId: `provider-${runId}`,
        externalTransactionId,
        idempotencyKey: `key-${runId}`,
        playerId,
        walletId,
        roundId: `round-${runId}`,
        gameId: 'integration-game',
        kind: 'BET',
        money: { amount: '10.00', currency: 'BRL' },
      },
    });

    await app.get(ProcessWagerUseCase).execute({
      providerId: `provider-${runId}`,
      externalTransactionId,
      idempotencyKey: `key-${runId}`,
      playerId,
      walletId,
      roundId: `round-${runId}`,
      gameId: 'integration-game',
      kind: 'BET',
      money: Money.from({ amount: '10.00', currency: 'BRL' }),
    }, { consumerName: 'wager-transactions-v1', messageId: wagerMessageId });
    // The committed inbox row models a worker that stopped before deleting its SQS message.
    await sendWager(messageBody, `first-${runId}`);
    await waitForVisibleMessages(0);
    await sendWager(messageBody, `redelivery-${runId}`);
    await waitForVisibleMessages(0);

    const persisted = await orm.em.getConnection().execute<Array<{ balance: string; inbox_count: number; outbox_count: number }>>(
      `SELECT w.balance, (SELECT count(*)::int FROM inbox_messages WHERE consumer_name = 'wager-transactions-v1' AND message_id = ?) AS inbox_count,
              (SELECT count(*)::int FROM outbox_messages WHERE aggregate_id = ? AND event_type = 'WagerTransactionProcessed') AS outbox_count
       FROM wallets w WHERE w.id = ?`,
      [wagerMessageId, walletId, walletId],
    );
    expect(persisted[0]).toEqual({ balance: '90.00', inbox_count: 1, outbox_count: 1 });

    const event = await receiveExpectedEvent(externalTransactionId);
    expect(event).toMatchObject({
      eventType: 'WagerTransactionProcessed',
      correlationId: externalTransactionId,
      causationId: expect.any(String),
      version: 1,
    });
    const eventId = event['eventId'];
    if (typeof eventId !== 'string') throw new Error('Published outbox event has no eventId');
    const published = await waitForPublishedOutbox(eventId);
    expect(published[0]).toEqual({ attempts: 1, published: true });
    const metrics = await fetch(`${baseUrl}/metrics`);
    const exposition = await metrics.text();
    expect(metrics.status).toBe(200);
    expect(metrics.headers.get('content-type')).toContain('text/plain');
    for (const metric of [
      'wager_transactions_total',
      'wager_idempotent_duplicates_total',
      'wager_retries_total',
      'wager_dlq_messages_total',
      'wager_lock_conflicts_total',
      'wager_outbox_lag_seconds',
      'wager_processing_duration_seconds',
    ]) {
      expect(exposition).toContain(metric);
    }
  }, 30_000);

  it('routes an invalid real SQS delivery to the provisioned DLQ', async () => {
    const marker = `invalid-${runId}`;
    await sendWager(marker, `bad-${runId}`);
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const received = await eventsQueue.send(new ReceiveMessageCommand({
        QueueUrl: process.env.SQS_DLQ_URL,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 1,
      }));
      const matching = received.Messages?.find((message) => message.Body === marker);
      if (matching?.ReceiptHandle !== undefined) {
        await eventsQueue.send(new DeleteMessageCommand({
          QueueUrl: process.env.SQS_DLQ_URL,
          ReceiptHandle: matching.ReceiptHandle,
        }));
        return;
      }
    }
    throw new Error('Invalid SQS message did not reach the dead-letter queue');
  }, 15_000);

  it('publishes a committed due outbox event after both publisher instances restart', async () => {
    const baseUrl = await app.getUrl();
    const playerId = crypto.randomUUID();
    const walletResponse = await fetch(`${baseUrl}/wallets`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ playerId, initialBalance: { amount: '0.00', currency: 'BRL' } }),
    });
    const walletBody: unknown = await walletResponse.json();
    if (!isJsonObject(walletBody) || typeof walletBody['id'] !== 'string') throw new Error('Wallet response has no id');
    const walletId = walletBody['id'];
    const eventId = uuidv7();
    const externalTransactionId = `restart-${runId}`;
    const payload = {
      eventId,
      eventType: 'WagerTransactionProcessed',
      aggregateId: walletId,
      correlationId: externalTransactionId,
      causationId: eventId,
      occurredAt: new Date().toISOString(),
      version: 1,
      data: { transactionId: eventId, externalTransactionId, status: 'PROCESSED' },
    };
    await orm.em.getConnection().execute(
      `INSERT INTO outbox_messages (id, aggregate_id, event_type, payload, occurred_at, next_attempt_at, attempts)
       VALUES (?, ?, ?, ?::jsonb, current_timestamp, current_timestamp + interval '60 seconds', 0)`,
      [eventId, walletId, 'WagerTransactionProcessed', JSON.stringify(payload)],
    );

    await Promise.all([app.close(), secondPublisherApp?.close()]);
    secondPublisherApp = undefined;
    const maintenanceApp = await NestFactory.create(OutboxMaintenanceModule, { logger: false });
    const maintenanceOrm = maintenanceApp.get(MikroORM);
    await maintenanceOrm.em.getConnection().execute(
      'UPDATE outbox_messages SET next_attempt_at = current_timestamp WHERE id = ?',
      [eventId],
    );
    await maintenanceApp.close();

    app = await NestFactory.create(WagerMessagingIntegrationModule, { logger: false });
    orm = app.get(MikroORM);
    await app.listen(0, '127.0.0.1');
    const event = await receiveExpectedEvent(externalTransactionId);
    expect(event['eventId']).toBe(eventId);

    const rows = await waitForPublishedOutbox(eventId);
    expect(rows[0]).toEqual({ attempts: 1, published: true });
  }, 45_000);
});

async function sendWager(body: string, deduplicationId: string): Promise<void> {
  await eventsQueue.send(new SendMessageCommand({
    QueueUrl: ingressQueueUrl,
    MessageBody: body,
    MessageGroupId: `group-${runId}`,
    MessageDeduplicationId: deduplicationId,
  }));
}

async function waitForVisibleMessages(expected: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const response = await eventsQueue.send(new GetQueueAttributesCommand({
      QueueUrl: ingressQueueUrl,
      AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'],
    }));
    const visible = Number(response.Attributes?.['ApproximateNumberOfMessages'] ?? '-1');
    const inFlight = Number(response.Attributes?.['ApproximateNumberOfMessagesNotVisible'] ?? '-1');
    if (visible <= expected && inFlight <= expected) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('SQS message was not acknowledged');
}

async function waitForPublishedOutbox(eventId: string): Promise<Array<{ attempts: number; published: boolean }>> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const rows = await orm.em.getConnection().execute<Array<{ attempts: number; published: boolean }>>(
      'SELECT attempts, (published_at IS NOT NULL) AS published FROM outbox_messages WHERE id = ?',
      [eventId],
    );
    if (rows[0]?.published === true) return rows;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Outbox publisher did not record the successful send');
}

async function receiveExpectedEvent(transactionId: string): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const received = await eventsQueue.send(new ReceiveMessageCommand({
      QueueUrl: eventsQueueUrl,
      MaxNumberOfMessages: 10,
      WaitTimeSeconds: 1,
    }));
    for (const message of received.Messages ?? []) {
      if (message.Body === undefined || message.ReceiptHandle === undefined) continue;
      const body: unknown = JSON.parse(message.Body);
      const data = isJsonObject(body) ? body['data'] : undefined;
      const matches = isJsonObject(data) && data['externalTransactionId'] === transactionId;
      await eventsQueue.send(new DeleteMessageCommand({ QueueUrl: eventsQueueUrl, ReceiptHandle: message.ReceiptHandle }));
      if (matches && isJsonObject(body)) return body;
    }
  }
  throw new Error('Outbox event was not published to the configured FIFO queue');
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
