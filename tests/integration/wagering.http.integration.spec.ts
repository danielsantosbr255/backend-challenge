import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { MikroORM } from '@mikro-orm/core';
import { Migrator } from '@mikro-orm/migrations';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { Module, ValidationPipe, type INestApplication } from '@nestjs/common';
import { APP_FILTER, NestFactory } from '@nestjs/core';
import { WalletModule } from '@/modules/wallet/wallet.module';
import { WagerModule } from '@/modules/wager/wager.module';
import { mikroOrmConfig } from '@/infrastructure/persistence/mikro-orm.config';
import { GlobalHttpExceptionFilter } from '@/infrastructure/http/global-http-exception.filter';
import { ProcessWagerUseCase } from '@/modules/wager/use-cases/process-wager.use-case';
import { Money } from '@/modules/wallet/domain/money';

let testOrm: MikroORM;
let testApp: INestApplication;
let testBaseUrl: string;

@Module({
  imports: [
    MikroOrmModule.forRoot({ ...mikroOrmConfig, extensions: [Migrator] }),
    WalletModule,
    WagerModule,
  ],
  providers: [{ provide: APP_FILTER, useClass: GlobalHttpExceptionFilter }],
})
class WageringHttpTestModule {}

describe('Wagering HTTP processing', () => {
  beforeAll(async () => {
    testApp = await NestFactory.create(WageringHttpTestModule, { logger: false });
    testApp.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    testOrm = testApp.get(MikroORM);
    await testOrm.migrator.up();
    await testApp.listen(0, '127.0.0.1');
    testBaseUrl = await testApp.getUrl();
  }, 30_000);

  afterAll(async () => {
    await testApp?.close();
  }, 30_000);

  it('applies one debit for 50 parallel deliveries of the same wager and replays the original result', async () => {
    const walletId = await createWallet('100.00');
    const request = wagerRequest(walletId, 'parallel-identical', '80.00');
    const results = await Promise.all(Array.from({ length: 50 }, () => submit(request)));

    expect(results.every((result) => result.status === 200)).toBe(true);
    const bodies = await Promise.all(results.map((result) => result.json() as Promise<WagerResponse>));
    expect(bodies.filter((body) => body.idempotentReplay)).toHaveLength(49);
    expect(new Set(bodies.map((body) => body.transactionId)).size).toBe(1);
    expect(new Set(bodies.map((body) => body.balance.amount))).toEqual(new Set(['20.00']));
    expect(await financialCounts(walletId)).toEqual({ transactions: 2, ledger: 2, outbox: 2 });
    expect(await readBalance(walletId)).toBe('20.00');
  }, 30_000);

  it('serializes competing bets on one wallet and rejects the debit that would overdraw it', async () => {
    const walletId = await createWallet('100.00');
    const requests = [
      wagerRequest(walletId, 'parallel-bet-a', '80.00'),
      wagerRequest(walletId, 'parallel-bet-b', '80.00'),
    ];
    const responses = await Promise.all(requests.map(submit));
    const bodies = await Promise.all(responses.map((response) => response.json() as Promise<WagerResponse>));

    expect(responses.map((response) => response.status).sort()).toEqual([200, 422]);
    expect(bodies.map((body) => body.status).sort()).toEqual(['PROCESSED', 'REJECTED']);
    expect(bodies.find((body) => body.status === 'REJECTED')?.failureCode).toBe('INSUFFICIENT_FUNDS');
    expect(await readBalance(walletId)).toBe('20.00');
    expect(await financialCounts(walletId)).toEqual({ transactions: 3, ledger: 2, outbox: 3 });
  }, 30_000);

  it('returns 409 when the same idempotency key is reused with a different payload', async () => {
    const walletId = await createWallet('100.00');
    const first = await submit(wagerRequest(walletId, 'same-key-conflict', '10.00'));
    const second = await submit(wagerRequest(walletId, 'same-key-conflict', '11.00'));
    const conflictBody: unknown = await second.json();

    expect(first.status).toBe(200);
    expect(second.status).toBe(409);
    expect(isJsonObject(conflictBody) ? conflictBody['code'] : undefined).toBe('WAGER_IDEMPOTENCY_CONFLICT');
    expect(await readBalance(walletId)).toBe('90.00');
  });

  it('credits WIN and records LOSS without moving the balance or creating a ledger entry', async () => {
    const walletId = await createWallet('10.00');
    const win = await submit(wagerRequest(walletId, 'win-credit', '5.00', 'WIN'));
    const loss = await submit(wagerRequest(walletId, 'loss-no-movement', '5.00', 'LOSS'));
    const winBody = await win.json() as WagerResponse;
    const lossBody = await loss.json() as WagerResponse;

    expect(winBody.balance.amount).toBe('15.00');
    expect(lossBody.balance.amount).toBe('15.00');
    expect(await readBalance(walletId)).toBe('15.00');
    expect(await financialCounts(walletId)).toEqual({ transactions: 3, ledger: 2, outbox: 3 });
  });

  it('commits the SQS inbox reservation atomically and suppresses redelivery', async () => {
    const walletId = await createWallet('100.00');
    const request = wagerRequest(walletId, 'inbox-redelivery', '10.00');
    const useCase = testApp.get(ProcessWagerUseCase);
    const playerId = walletPlayerIds.get(walletId);
    if (playerId === undefined) throw new Error('Wallet player ID is missing');
    const input = {
      providerId: request.body.providerId,
      externalTransactionId: request.body.externalTransactionId,
      idempotencyKey: request.key,
      playerId,
      walletId,
      roundId: request.body.roundId,
      gameId: request.body.gameId,
      kind: request.body.kind,
      money: Money.from(request.body.money),
    };
    const ingress = {
      consumerName: 'wager-transactions-v1',
      messageId: 'sqs-message-redelivery',
    };

    const first = await useCase.execute(input, ingress);
    const replay = await useCase.execute(input, ingress);
    expect(first.idempotentReplay).toBe(false);
    expect(replay.idempotentReplay).toBe(true);

    const rows = await testOrm.em.getConnection().execute<Array<{ inbox: number; ledger: number }>>(
      `SELECT
         (SELECT count(*)::int FROM inbox_messages WHERE consumer_name = ? AND message_id = ?) AS inbox,
         (SELECT count(*)::int FROM wallet_ledger_entries WHERE wallet_id = ?) AS ledger`,
      [ingress.consumerName, ingress.messageId, walletId],
    );
    expect(rows[0]).toEqual({ inbox: 1, ledger: 2 });
    expect(await readBalance(walletId)).toBe('90.00');
  });
});

interface WagerResponse {
  transactionId: string;
  status: 'PROCESSED' | 'REJECTED';
  balance: { amount: string; currency: string };
  idempotentReplay: boolean;
  failureCode?: string;
}

function wagerRequest(walletId: string, key: string, amount: string, kind: 'BET' | 'WIN' | 'LOSS' = 'BET') {
  return {
    key,
    body: {
      providerId: 'integration-provider',
      externalTransactionId: key,
      playerId: walletPlayerIds.get(walletId),
      walletId,
      roundId: 'integration-round',
      gameId: 'integration-game',
      kind,
      money: { amount, currency: 'BRL' },
    },
  };
}

const walletPlayerIds = new Map<string, string>();

async function createWallet(amount: string): Promise<string> {
  const playerId = crypto.randomUUID();
  const response = await fetch(`${testBaseUrl}/wallets`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ playerId, initialBalance: { amount, currency: 'BRL' } }),
  });
  const body: unknown = await response.json();
  if (!isJsonObject(body) || typeof body['id'] !== 'string') {
    throw new Error('Wallet creation response did not include an ID');
  }
  walletPlayerIds.set(body['id'], playerId);
  return body['id'];
}

function submit(request: ReturnType<typeof wagerRequest>): Promise<Response> {
  return fetch(`${testBaseUrl}/wagering/transactions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': request.key },
    body: JSON.stringify(request.body),
  });
}

async function financialCounts(walletId: string): Promise<{ transactions: number; ledger: number; outbox: number }> {
  const rows = await testOrm.em.getConnection().execute<
    { transactions: number; ledger: number; outbox: number }[]
  >(
    `SELECT
       (SELECT count(*)::int FROM wager_transactions WHERE wallet_id = ?) AS transactions,
       (SELECT count(*)::int FROM wallet_ledger_entries WHERE wallet_id = ?) AS ledger,
       (SELECT count(*)::int FROM outbox_messages WHERE aggregate_id = ?) AS outbox`,
    [walletId, walletId, walletId],
  );
  return rows[0];
}

async function readBalance(walletId: string): Promise<string> {
  const rows = await testOrm.em.getConnection().execute<{ balance: string }[]>(
    'SELECT balance FROM wallets WHERE id = ?',
    [walletId],
  );
  return rows[0].balance;
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
