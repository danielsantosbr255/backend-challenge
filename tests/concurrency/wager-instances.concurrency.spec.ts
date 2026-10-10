import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { MikroORM } from '@mikro-orm/core';
import { Migrator } from '@mikro-orm/migrations';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { Module, ValidationPipe, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { APP_FILTER } from '@nestjs/core';
import { GlobalHttpExceptionFilter } from '@/infrastructure/http/global-http-exception.filter';
import { mikroOrmConfig } from '@/infrastructure/persistence/mikro-orm.config';
import { WalletModule } from '@/modules/wallet/wallet.module';
import { WagerModule } from '@/modules/wager/wager.module';

const runId = crypto.randomUUID();

@Module({
  imports: [
    MikroOrmModule.forRoot({ ...mikroOrmConfig, extensions: [Migrator] }),
    WalletModule,
    WagerModule,
  ],
  providers: [{ provide: APP_FILTER, useClass: GlobalHttpExceptionFilter }],
})
class WagerInstanceTestModule {}

describe('wager concurrency across application instances', () => {
  const applications: INestApplication[] = [];
  const urls: string[] = [];
  let orm: MikroORM;

  beforeAll(async () => {
    for (let instance = 0; instance < 3; instance += 1) {
      const application = await NestFactory.create(WagerInstanceTestModule, { logger: false });
      application.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
      if (instance === 0) {
        orm = application.get(MikroORM);
        await orm.migrator.up();
      }
      await application.listen(0, '127.0.0.1');
      applications.push(application);
      urls.push(await application.getUrl());
    }
  }, 30_000);

  afterAll(async () => {
    await Promise.all(applications.map((application) => application.close()));
  }, 30_000);

  it('serializes duplicate and competing requests across three independent Nest applications', async () => {
    const wallet = await createWallet('100.00');
    const duplicateRequests = Array.from({ length: 50 }, (_, index) =>
      submit(index % 3, wager(wallet.id, wallet.playerId, 'shared-operation', '80.00')),
    );
    const duplicateResponses = await Promise.all(duplicateRequests);
    const duplicateBodies = await Promise.all(duplicateResponses.map(readWagerResponse));

    expect(duplicateResponses.every((response) => response.status === 200)).toBe(true);
    expect(duplicateBodies.filter((body) => body.idempotentReplay)).toHaveLength(49);
    expect(new Set(duplicateBodies.map((body) => body.transactionId)).size).toBe(1);
    expect(await readWallet(wallet.id)).toEqual({ balance: '20.00', ledger_balance: '20.00', debits: 1 });

    const secondWallet = await createWallet('100.00');
    const competing = await Promise.all([
      submit(0, wager(secondWallet.id, secondWallet.playerId, 'competing-a', '80.00')),
      submit(1, wager(secondWallet.id, secondWallet.playerId, 'competing-b', '80.00')),
    ]);
    expect(competing.map((response) => response.status).sort()).toEqual([200, 422]);
    expect(await readWallet(secondWallet.id)).toEqual({ balance: '20.00', ledger_balance: '20.00', debits: 1 });

    const independentWallets = await Promise.all([createWallet('100.00'), createWallet('100.00')]);
    await Promise.all(independentWallets.map((item, index) =>
      submit(index, wager(item.id, item.playerId, `independent-${runId}-${index}`, '60.00')),
    ));
    expect(await Promise.all(independentWallets.map((item) => readWallet(item.id)))).toEqual([
      { balance: '40.00', ledger_balance: '40.00', debits: 1 },
      { balance: '40.00', ledger_balance: '40.00', debits: 1 },
    ]);
  }, 30_000);

  async function createWallet(amount: string): Promise<{ id: string; playerId: string }> {
    const playerId = crypto.randomUUID();
    const response = await fetch(`${requiredUrl(0)}/wallets`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ playerId, initialBalance: { amount, currency: 'BRL' } }),
    });
    const body: unknown = await response.json();
    if (!isJsonObject(body) || typeof body['id'] !== 'string') throw new Error('Wallet response has no id');
    return { id: body['id'], playerId };
  }

  function submit(instance: number, request: WagerRequest): Promise<Response> {
    return fetch(`${requiredUrl(instance)}/wagering/transactions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': request.externalTransactionId },
      body: JSON.stringify(request),
    });
  }

  async function readWallet(walletId: string): Promise<{ balance: string; ledger_balance: string; debits: number }> {
    const rows = await orm.em.getConnection().execute<Array<{ balance: string; ledger_balance: string; debits: number }>>(
      `SELECT w.balance, COALESCE(SUM(CASE WHEN e.direction = 'CREDIT' THEN e.amount ELSE -e.amount END), 0)::numeric(18,2)::text AS ledger_balance,
              COUNT(e.id) FILTER (WHERE e.direction = 'DEBIT')::int AS debits
       FROM wallets w LEFT JOIN wallet_ledger_entries e ON e.wallet_id = w.id
       WHERE w.id = ? GROUP BY w.id`,
      [walletId],
    );
    return rows[0];
  }

  function requiredUrl(instance: number): string {
    const url = urls[instance];
    if (url === undefined) throw new Error(`Nest application instance ${instance} is not available`);
    return url;
  }
});

interface WagerRequest {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: 'BET';
  money: { amount: string; currency: string };
}

interface WagerResponse {
  transactionId: string;
  idempotentReplay: boolean;
}

function wager(walletId: string, playerId: string, externalTransactionId: string, amount: string): WagerRequest {
  return {
    providerId: `concurrency-${runId}`,
    externalTransactionId,
    playerId,
    walletId,
    roundId: `round-${runId}`,
    gameId: 'concurrency-test',
    kind: 'BET',
    money: { amount, currency: 'BRL' },
  };
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function readWagerResponse(response: Response): Promise<WagerResponse> {
  const body: unknown = await response.json();
  if (
    !isJsonObject(body) ||
    typeof body['transactionId'] !== 'string' ||
    typeof body['idempotentReplay'] !== 'boolean'
  ) {
    throw new Error('Wager response did not match its contract');
  }
  return { transactionId: body['transactionId'], idempotentReplay: body['idempotentReplay'] };
}
