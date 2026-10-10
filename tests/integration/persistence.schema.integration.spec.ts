import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { MikroORM } from '@mikro-orm/core';
import { Migrator } from '@mikro-orm/migrations';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { Module, ValidationPipe, type INestApplication } from '@nestjs/common';
import { APP_FILTER, NestFactory } from '@nestjs/core';
import { GlobalHttpExceptionFilter } from '@/infrastructure/http/global-http-exception.filter';
import { WalletModule } from '@/modules/wallet/wallet.module';
import { mikroOrmConfig } from '@/infrastructure/persistence/mikro-orm.config';
import { InboxMessageEntity } from '@/modules/wager/entities/inbox-message.entity';
import { OutboxMessageEntity } from '@/modules/wager/entities/outbox-message.entity';
import { WalletLedgerEntryEntity } from '@/modules/wallet/entities/wallet-ledger-entry.entity';
import { WalletEntity } from '@/modules/wallet/entities/wallet.entity';
import { WagerTransactionEntity } from '@/modules/wager/entities/wager-transaction.entity';

let testOrm: MikroORM;
let testApp: INestApplication;
let testBaseUrl: string;

@Module({
  imports: [
    MikroOrmModule.forRoot({
      ...mikroOrmConfig,
      extensions: [Migrator],
    }),
    WalletModule,
  ],
  providers: [{ provide: APP_FILTER, useClass: GlobalHttpExceptionFilter }],
})
class PersistenceTestModule {}

describe('PostgreSQL financial schema migrations', () => {
  let migrationAppliedBySuite = false;

  beforeAll(async () => {
    testApp = await NestFactory.create(PersistenceTestModule, { logger: false });
    testApp.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    testOrm = testApp.get(MikroORM);
    const existingTables = await testOrm.em.getConnection().execute<{ table_name: string | null }[]>(
      "SELECT to_regclass('public.wallets')::text AS table_name",
    );
    migrationAppliedBySuite = existingTables[0]?.table_name == null;
    await testOrm.migrator.up();
    await testApp.listen(0, '127.0.0.1');
    testBaseUrl = await testApp.getUrl();
  }, 30_000);

  afterAll(async () => {
    if (migrationAppliedBySuite) {
      await testOrm.migrator.down();
    }
    await testApp.close();
  }, 30_000);

  it('registers each financial table as a TypeScript MikroORM entity', async () => {
    expect(mikroOrmConfig.entities).toEqual(
      expect.arrayContaining([
        WalletEntity,
        WagerTransactionEntity,
        WalletLedgerEntryEntity,
        InboxMessageEntity,
        OutboxMessageEntity,
      ]),
    );
    const missingId = '00000000-0000-4000-8000-000000000000';
    const [wallet, transaction, ledger, inbox, outbox] = await Promise.all([
      testOrm.em.fork().findOne(WalletEntity, { id: missingId }),
      testOrm.em.fork().findOne(WagerTransactionEntity, { id: missingId }),
      testOrm.em.fork().findOne(WalletLedgerEntryEntity, { id: missingId }),
      testOrm.em.fork().findOne(InboxMessageEntity, { consumerName: '__missing__', messageId: '__missing__' }),
      testOrm.em.fork().findOne(OutboxMessageEntity, { id: missingId }),
    ]);
    expect([wallet, transaction, ledger, inbox, outbox]).toEqual([null, null, null, null, null]);
  });

  it('creates all required tables with native UUID and exact decimal columns', async () => {
    const columns = await testOrm.em.getConnection().execute<
      { table_name: string; column_name: string; data_type: string; numeric_precision: number | null; numeric_scale: number | null }[]
    >(
      `SELECT table_name, column_name, data_type, numeric_precision, numeric_scale
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name IN ('wallets', 'wager_transactions', 'wallet_ledger_entries', 'inbox_messages', 'outbox_messages')`,
    );

    expect(new Set(columns.map((column: { table_name: string }) => column.table_name))).toEqual(
      new Set(['wallets', 'wager_transactions', 'wallet_ledger_entries', 'inbox_messages', 'outbox_messages']),
    );
    expect(columns.find((column: { table_name: string; column_name: string }) => column.table_name === 'wallets' && column.column_name === 'id')?.data_type).toBe('uuid');
    expect(columns.find((column: { table_name: string; column_name: string }) => column.table_name === 'wallets' && column.column_name === 'balance')).toMatchObject({
      data_type: 'numeric',
      numeric_precision: 18,
      numeric_scale: 2,
    });
  });

  it('creates the wallet, opening transaction, and ledger entry through POST /wallets', async () => {
    const playerId = crypto.randomUUID();
    const response = await fetch(`${testBaseUrl}/wallets`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ playerId, initialBalance: { amount: '25.50', currency: 'BRL' } }),
    });
    const body: unknown = await response.json();

    expect(response.status).toBe(201);
    expect(isJsonObject(body)).toBe(true);
    if (!isJsonObject(body) || typeof body['id'] !== 'string') {
      throw new Error('Create wallet response did not contain a wallet ID');
    }
    const walletId = body['id'];
    expect(body).toMatchObject({
      playerId,
      balance: { amount: '25.50', currency: 'BRL' },
      version: 1,
    });

    const counts = await testOrm.em.getConnection().execute<
      { wallets: number; transactions: number; ledger_entries: number }[]
    >(
      `SELECT
         (SELECT count(*)::int FROM wallets WHERE id = ?) AS wallets,
         (SELECT count(*)::int FROM wager_transactions WHERE wallet_id = ?) AS transactions,
         (SELECT count(*)::int FROM wallet_ledger_entries WHERE wallet_id = ?) AS ledger_entries`,
      [walletId, walletId, walletId],
    );
    expect(counts[0]).toEqual({ wallets: 1, transactions: 1, ledger_entries: 1 });
  });

  it('creates no opening transaction or ledger entry when the initial balance is zero', async () => {
    const playerId = crypto.randomUUID();
    const response = await fetch(`${testBaseUrl}/wallets`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ playerId, initialBalance: { amount: '0.00', currency: 'USD' } }),
    });
    const body: unknown = await response.json();

    expect(response.status).toBe(201);
    expect(isJsonObject(body)).toBe(true);
    if (!isJsonObject(body) || typeof body['id'] !== 'string') {
      throw new Error('Create wallet response did not contain a wallet ID');
    }
    expect(body['balance']).toEqual({ amount: '0.00', currency: 'USD' });

    const counts = await testOrm.em.getConnection().execute<
      { transactions: number; ledger_entries: number; outbox: number }[]
    >(
      `SELECT
         (SELECT count(*)::int FROM wager_transactions WHERE wallet_id = ?) AS transactions,
         (SELECT count(*)::int FROM wallet_ledger_entries WHERE wallet_id = ?) AS ledger_entries,
         (SELECT count(*)::int FROM outbox_messages WHERE aggregate_id = ?) AS outbox`,
      [body['id'], body['id'], body['id']],
    );
    expect(counts[0]).toEqual({ transactions: 0, ledger_entries: 0, outbox: 0 });
  });

  it('returns 409 for a duplicate player and currency wallet', async () => {
    const playerId = crypto.randomUUID();
    const payload = JSON.stringify({ playerId, initialBalance: { amount: '0.00', currency: 'BRL' } });
    const requestOptions: RequestInit = {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: payload,
    };
    const firstResponse = await fetch(`${testBaseUrl}/wallets`, requestOptions);
    const secondResponse = await fetch(`${testBaseUrl}/wallets`, requestOptions);
    const secondBody: unknown = await secondResponse.json();

    expect(firstResponse.status).toBe(201);
    expect(secondResponse.status).toBe(409);
    expect(isJsonObject(secondBody) ? secondBody['code'] : undefined).toBe('WALLET_ALREADY_EXISTS');
  });

  it('rolls back wallet and opening transaction when ledger persistence fails', async () => {
    const playerId = crypto.randomUUID();
    const connection = testOrm.em.getConnection();
    await connection.execute(
      `CREATE FUNCTION test_reject_wallet_opening_ledger() RETURNS trigger AS $$
       BEGIN
         RAISE EXCEPTION 'forced ledger failure for atomicity test';
       END;
       $$ LANGUAGE plpgsql`,
    );
    await connection.execute(
      `CREATE TRIGGER test_reject_wallet_opening_ledger
       BEFORE INSERT ON wallet_ledger_entries
       FOR EACH ROW EXECUTE FUNCTION test_reject_wallet_opening_ledger()`,
    );

    try {
      const response = await fetch(`${testBaseUrl}/wallets`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ playerId, initialBalance: { amount: '13.37', currency: 'BRL' } }),
      });
      expect(response.status).toBe(500);
      expect(await response.text()).not.toContain('forced ledger failure');
    } finally {
      await connection.execute('DROP TRIGGER test_reject_wallet_opening_ledger ON wallet_ledger_entries');
      await connection.execute('DROP FUNCTION test_reject_wallet_opening_ledger()');
    }

    const counts = await connection.execute<
      { wallets: number; transactions: number; ledger_entries: number }[]
    >(
      `SELECT
         count(DISTINCT wallets.id)::int AS wallets,
         count(DISTINCT wager_transactions.id)::int AS transactions,
         count(DISTINCT wallet_ledger_entries.id)::int AS ledger_entries
       FROM (SELECT ?::uuid AS player_id) AS input
       LEFT JOIN wallets ON wallets.player_id = input.player_id
       LEFT JOIN wager_transactions ON wager_transactions.wallet_id = wallets.id
       LEFT JOIN wallet_ledger_entries ON wallet_ledger_entries.wallet_id = wallets.id`,
      [playerId],
    );
    expect(counts[0]).toEqual({ wallets: 0, transactions: 0, ledger_entries: 0 });
  });

  it('rejects malformed money at the HTTP boundary', async () => {
    const response = await fetch(`${testBaseUrl}/wallets`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        playerId: crypto.randomUUID(),
        initialBalance: { amount: '1.005', currency: 'BRL' },
      }),
    });

    expect(response.status).toBe(400);
  });

  it('rejects duplicate player and currency wallets and negative balances', async () => {
    const connection = testOrm.em.getConnection();
    const playerId = crypto.randomUUID();
    const firstWalletId = crypto.randomUUID();
    await connection.execute(
      'INSERT INTO wallets (id, player_id, currency, balance) VALUES (?, ?, ?, ?)',
      [firstWalletId, playerId, 'BRL', '0.00'],
    );

    await expect(
      connection.execute(
        'INSERT INTO wallets (id, player_id, currency, balance) VALUES (?, ?, ?, ?)',
        [crypto.randomUUID(), playerId, 'BRL', '1.00'],
      ),
    ).rejects.toThrow();
    await expect(
      connection.execute('INSERT INTO wallets (id, player_id, currency, balance) VALUES (?, ?, ?, ?)', [
        crypto.randomUUID(),
        crypto.randomUUID(),
        'BRL',
        '-0.01',
      ]),
    ).rejects.toThrow();
    await expect(
      connection.execute('INSERT INTO wallets (id, player_id, currency, balance) VALUES (?, ?, ?, ?)', [
        crypto.randomUUID(),
        crypto.randomUUID(),
        'BRL',
        'NaN',
      ]),
    ).rejects.toThrow();
  });

  it('enforces idempotency and external transaction uniqueness per provider', async () => {
    const walletId = await createWallet();
    const transaction = transactionValues(walletId);
    const connection = testOrm.em.getConnection();
    await insertTransaction(connection, transaction);

    await expect(
      insertTransaction(connection, {
        ...transaction,
        id: crypto.randomUUID(),
        idempotencyKey: 'different-key',
      }),
    ).rejects.toThrow();
    await expect(
      insertTransaction(connection, {
        ...transaction,
        id: crypto.randomUUID(),
        externalTransactionId: crypto.randomUUID(),
      }),
    ).rejects.toThrow();
  });

  it('requires both persisted response balance fields together', async () => {
    const walletId = await createWallet();
    const transaction = transactionValues(walletId);

    await expect(
      testOrm.em.getConnection().execute(
        `INSERT INTO wager_transactions
           (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id,
            round_id, game_id, kind, amount, currency, status, response_balance_amount)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '10.00', 'BRL', ?, '5.00')`,
        [
          transaction.id,
          transaction.providerId,
          transaction.externalTransactionId,
          transaction.idempotencyKey,
          transaction.payloadHash,
          transaction.walletId,
          transaction.playerId,
          transaction.roundId,
          transaction.gameId,
          transaction.kind,
          transaction.status,
        ],
      ),
    ).rejects.toThrow();
  });

  it('enforces ledger arithmetic and prevents updates and deletes', async () => {
    const walletId = await createWallet();
    const transaction = transactionValues(walletId);
    const connection = testOrm.em.getConnection();
    await insertTransaction(connection, transaction);

    await connection.execute(
      `INSERT INTO wallet_ledger_entries
         (id, wallet_id, transaction_id, direction, amount, balance_before, balance_after)
       VALUES (?, ?, ?, 'CREDIT', '10.00', '0.00', '10.00')`,
      [crypto.randomUUID(), walletId, transaction.id],
    );

    const invalidArithmeticTransaction = transactionValues(walletId);
    await insertTransaction(connection, invalidArithmeticTransaction);
    await expect(
      connection.execute(
        `INSERT INTO wallet_ledger_entries
           (id, wallet_id, transaction_id, direction, amount, balance_before, balance_after)
         VALUES (?, ?, ?, 'CREDIT', '10.00', '0.00', '9.00')`,
        [crypto.randomUUID(), walletId, invalidArithmeticTransaction.id],
      ),
    ).rejects.toThrow();
    await expect(
      connection.execute('UPDATE wallet_ledger_entries SET amount = ? WHERE transaction_id = ?', ['9.00', transaction.id]),
    ).rejects.toThrow();
    await expect(connection.execute('DELETE FROM wallet_ledger_entries WHERE transaction_id = ?', [transaction.id])).rejects.toThrow();
  });

  it('allows same reversal reference and kind for different providers', async () => {
    const walletId = await createWallet();
    const reference = transactionValues(walletId);
    const connection = testOrm.em.getConnection();
    await insertTransaction(connection, reference);

    const firstReversal = transactionValues(walletId, {
      providerId: 'provider-a',
      kind: 'REFUND',
      referenceTransactionId: reference.id,
      status: 'PROCESSED',
      idempotencyKey: crypto.randomUUID(),
      externalTransactionId: crypto.randomUUID(),
    });
    const secondReversal = transactionValues(walletId, {
      providerId: 'provider-b',
      kind: 'REFUND',
      referenceTransactionId: reference.id,
      status: 'PROCESSED',
      idempotencyKey: crypto.randomUUID(),
      externalTransactionId: crypto.randomUUID(),
    });

    await insertTransaction(connection, firstReversal);
    await insertTransaction(connection, secondReversal);
    await expect(
      insertTransaction(connection, {
        ...firstReversal,
        id: crypto.randomUUID(),
        externalTransactionId: crypto.randomUUID(),
        idempotencyKey: crypto.randomUUID(),
      }),
    ).rejects.toThrow();
  });

  it('reverts the migration when this suite applied it', async () => {
    if (!migrationAppliedBySuite) {
      return;
    }

    await testOrm.migrator.down();
    const tables = await testOrm.em.getConnection().execute<{ table_name: string | null }[]>(
      "SELECT to_regclass('public.wallets')::text AS table_name",
    );
    expect(tables[0]?.table_name).toBeNull();
    migrationAppliedBySuite = false;
  });
});

interface TransactionValues {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: 'BET' | 'REFUND';
  referenceTransactionId: string | null;
  status: 'PROCESSED';
}

function transactionValues(
  walletId: string,
  overrides: Partial<TransactionValues> = {},
): TransactionValues {
  return {
    id: crypto.randomUUID(),
    providerId: 'provider-a',
    externalTransactionId: crypto.randomUUID(),
    idempotencyKey: crypto.randomUUID(),
    payloadHash: 'a'.repeat(64),
    walletId,
    playerId: crypto.randomUUID(),
    roundId: 'round-1',
    gameId: 'game-1',
    kind: 'BET',
    referenceTransactionId: null,
    status: 'PROCESSED',
    ...overrides,
  };
}

async function createWallet(): Promise<string> {
  const walletId = crypto.randomUUID();
  await testOrm.em.getConnection().execute(
    'INSERT INTO wallets (id, player_id, currency, balance) VALUES (?, ?, ?, ?)',
    [walletId, crypto.randomUUID(), 'BRL', '100.00'],
  );
  return walletId;
}

async function insertTransaction(
  connection: ReturnType<MikroORM['em']['getConnection']>,
  values: TransactionValues,
): Promise<void> {
  await connection.execute(
    `INSERT INTO wager_transactions
       (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id,
        round_id, game_id, kind, amount, currency, reference_transaction_id, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '10.00', 'BRL', ?, ?)`,
    [
      values.id,
      values.providerId,
      values.externalTransactionId,
      values.idempotencyKey,
      values.payloadHash,
      values.walletId,
      values.playerId,
      values.roundId,
      values.gameId,
      values.kind,
      values.referenceTransactionId,
      values.status,
    ],
  );
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
