import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Subprocess } from 'bun';
import { CreateQueueCommand, DeleteQueueCommand, GetQueueAttributesCommand, SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { MikroORM } from '@mikro-orm/core';
import { Migrator } from '@mikro-orm/migrations';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { Module, ValidationPipe, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { mikroOrmConfig } from '@/infrastructure/persistence/mikro-orm.config';
import { WalletModule } from '@/modules/wallet/wallet.module';

@Module({ imports: [MikroOrmModule.forRoot({ ...mikroOrmConfig, extensions: [Migrator] }), WalletModule] })
class CrashRecoveryHttpModule {}

const runId = crypto.randomUUID();
const sqs = new SQSClient({ region: 'us-east-1', endpoint: 'http://localhost:4566',
  credentials: { accessKeyId: 'test', secretAccessKey: 'test' } });
const queueUrls: string[] = [];
let app: INestApplication;
let orm: MikroORM;

describe('Recovery after an actual worker process crash', () => {
  beforeAll(async () => {
    for (const name of ['ingress', 'dlq', 'events']) {
      const result = await sqs.send(new CreateQueueCommand({ QueueName: `crash-${name}-${runId}.fifo`,
        Attributes: { FifoQueue: 'true', ContentBasedDeduplication: 'false' } }));
      if (result.QueueUrl === undefined) throw new Error('Queue URL is missing');
      queueUrls.push(result.QueueUrl);
    }
    app = await NestFactory.create(CrashRecoveryHttpModule, { logger: false });
    app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }));
    orm = app.get(MikroORM);
    await orm.migrator.up();
    await app.listen(0, '127.0.0.1');
  }, 30_000);

  afterAll(async () => {
    await app?.close();
    for (const url of queueUrls) await sqs.send(new DeleteQueueCommand({ QueueUrl: url }));
    sqs.destroy();
  }, 30_000);

  it('kills a worker after the financial commit, restarts it and proves one debit and stable published events', async () => {
    const playerId = crypto.randomUUID();
    const response = await fetch(`${await app.getUrl()}/wallets`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ playerId, initialBalance: { amount: '100.00', currency: 'BRL' } }),
    });
    const wallet: unknown = await response.json();
    if (typeof wallet !== 'object' || wallet === null || !('id' in wallet) || typeof wallet.id !== 'string') {
      throw new Error('Wallet creation failed');
    }
    const walletId = wallet.id;
    const messageId = `crash-message-${runId}`;
    const body = JSON.stringify({ messageId, type: 'WagerTransactionRequested', occurredAt: new Date().toISOString(),
      data: { providerId: `crash-${runId}`, externalTransactionId: messageId, idempotencyKey: messageId,
        playerId, walletId, roundId: 'crash-round', gameId: 'crash-game', kind: 'BET',
        money: { amount: '10.00', currency: 'BRL' } } });
    const first = startWorker(true, walletId);
    let recovered: ReturnType<typeof startWorker> | undefined;
    try {
      await waitUntil(() => first.output.text.includes('WORKER_READY'), first);
      await sqs.send(new SendMessageCommand({ QueueUrl: queueUrls[0], MessageBody: body,
        MessageGroupId: walletId, MessageDeduplicationId: messageId }));
      await waitUntil(() => first.output.text.includes('COMMITTED_BEFORE_ACK'), first);
      await waitUntil(() => first.output.text.includes('CLAIMED_BEFORE_PUBLISH'), first);
      const beforeCrash = await readState(walletId, messageId);
      expect(beforeCrash).toMatchObject({ balance: '90.00', ledger_balance: '90.00', ledger: 2, inbox: 1 });
      const eventIds = await readEventIds(walletId);
      expect(eventIds).toHaveLength(4);
      const claims = await orm.em.getConnection().execute<Array<{ count: number }>>(
        'SELECT count(*)::int AS count FROM outbox_messages WHERE aggregate_id = ? AND claimed_by IS NOT NULL', [walletId],
      );
      expect(claims[0]?.count).toBe(1);
      first.process.kill('SIGKILL');
      await first.process.exited;
      // Advance only the abandoned lease deadline; no financial data or events are synthesized.
      await orm.em.getConnection().execute(
        "UPDATE outbox_messages SET claimed_until = current_timestamp - interval '1 second' WHERE aggregate_id = ? AND claimed_by IS NOT NULL",
        [walletId],
      );

      recovered = startWorker(false);
      await waitUntil(() => recovered?.output.text.includes('WORKER_READY') === true, recovered);
      const deadline = Date.now() + 20_000;
      let acknowledged = false;
      while (Date.now() < deadline) {
        const attributes = await sqs.send(new GetQueueAttributesCommand({ QueueUrl: queueUrls[0],
          AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'] }));
        const rows = await orm.em.getConnection().execute<Array<{ count: number }>>(
          'SELECT count(*)::int AS count FROM outbox_messages WHERE aggregate_id = ? AND published_at IS NOT NULL', [walletId],
        );
        acknowledged = attributes.Attributes?.['ApproximateNumberOfMessages'] === '0'
          && attributes.Attributes?.['ApproximateNumberOfMessagesNotVisible'] === '0' && rows[0]?.count === 4;
        if (acknowledged) break;
        await Bun.sleep(100);
      }
      expect(acknowledged).toBe(true);
      expect(await readState(walletId, messageId)).toEqual(beforeCrash);
      expect(await readEventIds(walletId)).toEqual(eventIds);
    } finally {
      first.process.kill('SIGKILL');
      recovered?.process.kill('SIGKILL');
      await Promise.all([first.process.exited, recovered?.process.exited]);
      await Promise.all([first.finished, recovered?.finished]);
    }
  }, 45_000);
});

function startWorker(blockAck: boolean, blockedWalletId?: string) {
  const process: Subprocess<'ignore', 'pipe', 'pipe'> = Bun.spawn([Bun.argv[0], 'run', 'tests/fixtures/crash-worker.ts'], {
    stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', env: { ...globalThis.process.env,
      SQS_QUEUE_URL: queueUrls[0], SQS_DLQ_URL: queueUrls[1], SQS_EVENTS_QUEUE_URL: queueUrls[2], BLOCK_ACK: String(blockAck),
      BLOCK_PUBLISH_WALLET_ID: blockedWalletId },
  });
  const output = { text: '' };
  const finished = (async () => {
    const reader = process.stdout.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      output.text += decoder.decode(chunk.value, { stream: true });
    }
  })();
  const errors = new Response(process.stderr).text();
  return { process, output, finished, errors };
}

async function waitUntil(condition: () => boolean, worker: ReturnType<typeof startWorker>): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (condition()) return;
    if (worker.process.exitCode !== null) throw new Error(`Worker exited: ${await worker.errors}`);
    await Bun.sleep(50);
  }
  throw new Error(`Worker checkpoint timed out: ${worker.output.text}`);
}

async function readState(walletId: string, messageId: string) {
  const rows = await orm.em.getConnection().execute<Array<{ balance: string; ledger_balance: string; ledger: number; inbox: number }>>(
    `SELECT w.balance, ROUND(COALESCE(SUM(CASE WHEN e.direction = 'CREDIT' THEN e.amount ELSE -e.amount END), 0), 2)::text AS ledger_balance,
      count(e.id)::int AS ledger, (SELECT count(*)::int FROM inbox_messages WHERE message_id = ?) AS inbox
     FROM wallets w LEFT JOIN wallet_ledger_entries e ON e.wallet_id = w.id WHERE w.id = ? GROUP BY w.id`, [messageId, walletId],
  );
  return rows[0];
}

async function readEventIds(walletId: string): Promise<string[]> {
  const rows: Array<{ id: string }> = await orm.em.getConnection().execute(
    'SELECT id FROM outbox_messages WHERE aggregate_id = ? ORDER BY id', [walletId],
  );
  return rows.map((row) => row.id);
}
