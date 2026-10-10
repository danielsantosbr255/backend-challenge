import { defineConfig, type Options } from '@mikro-orm/postgresql';
import { databaseEnvSchema } from '../config/env.schema';
import { InboxMessageEntity } from '@/modules/wager/entities/inbox-message.entity';
import { OutboxMessageEntity } from '@/modules/wager/entities/outbox-message.entity';
import { WalletLedgerEntryEntity } from '@/modules/wallet/entities/wallet-ledger-entry.entity';
import { WalletEntity } from '@/modules/wallet/entities/wallet.entity';
import { WagerTransactionEntity } from '@/modules/wager/entities/wager-transaction.entity';

const env = databaseEnvSchema.parse(process.env);

export const mikroOrmConfig: Options = defineConfig({
  host: env.DATABASE_HOST,
  port: env.DATABASE_PORT,
  user: env.DATABASE_USER,
  password: env.DATABASE_PASSWORD,
  dbName: env.DATABASE_NAME,
  debug: false,
  driverOptions: { connectionTimeoutMillis: 5000, statement_timeout: 10_000, idle_in_transaction_session_timeout: 15_000 },
  entities: [WalletEntity, WagerTransactionEntity, WalletLedgerEntryEntity, InboxMessageEntity, OutboxMessageEntity],
  discovery: {
    warnWhenNoEntities: false,
  },
  migrations: {
    path: './dist/infrastructure/persistence/migrations',
    pathTs: './src/infrastructure/persistence/migrations',
    tableName: 'mikro_orm_migrations',
    transactional: true,
    allOrNothing: true,
  },
  pool: {
    min: 2,
    max: 10,
  },
});
