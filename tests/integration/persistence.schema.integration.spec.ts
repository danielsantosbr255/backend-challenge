import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { MikroORM } from '@mikro-orm/core';
import { Migrator } from '@mikro-orm/migrations';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { Module, type INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { mikroOrmConfig } from '@/infrastructure/persistence/mikro-orm.config';
import { InboxMessageEntity } from '@/infrastructure/persistence/entities/inbox-message.entity';
import { OutboxMessageEntity } from '@/infrastructure/persistence/entities/outbox-message.entity';
import { WalletLedgerEntryEntity } from '@/infrastructure/persistence/entities/wallet-ledger-entry.entity';
import { WalletEntity } from '@/infrastructure/persistence/entities/wallet.entity';
import { WagerTransactionEntity } from '@/infrastructure/persistence/entities/wager-transaction.entity';

let testOrm: MikroORM;
let testApp: INestApplicationContext;

@Module({
  imports: [
    MikroOrmModule.forRoot({
      ...mikroOrmConfig,
      extensions: [Migrator],
    }),
  ],
})
class PersistenceTestModule {}

describe('PostgreSQL financial schema migrations', () => {
  let migrationAppliedBySuite = false;

  beforeAll(async () => {
    testApp = await NestFactory.createApplicationContext(PersistenceTestModule, { logger: false });
    testOrm = testApp.get(MikroORM);
    const existingTables = await testOrm.em.getConnection().execute<{ table_name: string | null }[]>(
      "SELECT to_regclass('public.wallets')::text AS table_name",
    );
    migrationAppliedBySuite = existingTables[0]?.table_name == null;
    await testOrm.migrator.up();
  });

  afterAll(async () => {
    if (migrationAppliedBySuite) {
      await testOrm.migrator.down();
    }
    await testApp.close();
  });

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
