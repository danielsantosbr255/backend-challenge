import { defineEntity, p } from '@mikro-orm/postgresql';
import { WalletEntity } from './wallet.entity';
import { WagerTransactionEntity } from '@/modules/wager/entities/wager-transaction.entity';

export type LedgerDirection = 'CREDIT' | 'DEBIT';

export const WalletLedgerEntryEntity = defineEntity({
  name: 'WalletLedgerEntry',
  tableName: 'wallet_ledger_entries',
  properties: {
    id: p.uuid().primary(),
    wallet: () => p.manyToOne(WalletEntity).fieldName('wallet_id').deleteRule('restrict'),
    transaction: () => p.manyToOne(WagerTransactionEntity).fieldName('transaction_id').deleteRule('restrict'),
    direction: p.string().$type<LedgerDirection>().length(8),
    amount: p.decimal('string').precision(18).scale(2),
    balanceBefore: p.decimal('string').fieldName('balance_before').precision(18).scale(2),
    balanceAfter: p.decimal('string').fieldName('balance_after').precision(18).scale(2),
    createdAt: p.datetime().fieldName('created_at').columnType('timestamptz').defaultRaw('current_timestamp'),
  },
  uniques: [{ name: 'wallet_ledger_entries_wallet_transaction_unique', properties: ['wallet', 'transaction'] }],
  indexes: [
    {
      name: 'wallet_ledger_entries_wallet_created_idx',
      expression: 'create index "wallet_ledger_entries_wallet_created_idx" on "wallet_ledger_entries" ("wallet_id", "created_at" DESC, "id" DESC)',
    },
  ],
  checks: [
    {
      name: 'wallet_ledger_entries_direction_check',
      expression: (columns) => `${columns.direction} IN ('CREDIT', 'DEBIT')`,
    },
    {
      name: 'wallet_ledger_entries_amount_check',
      expression: (columns) => `${columns.amount} > 0 AND ${columns.amount} <> 'NaN'::numeric`,
    },
    {
      name: 'wallet_ledger_entries_balance_values_check',
      expression: (columns) =>
        `${columns.balanceBefore} >= 0 AND ${columns.balanceBefore} <> 'NaN'::numeric ` +
        `AND ${columns.balanceAfter} >= 0 AND ${columns.balanceAfter} <> 'NaN'::numeric`,
    },
    {
      name: 'wallet_ledger_entries_arithmetic_check',
      expression: (columns) =>
        `(${columns.direction} = 'CREDIT' AND ${columns.balanceAfter} = ${columns.balanceBefore} + ${columns.amount}) ` +
        `OR (${columns.direction} = 'DEBIT' AND ${columns.balanceAfter} = ${columns.balanceBefore} - ${columns.amount})`,
    },
  ],
  triggers: [
    {
      name: 'wallet_ledger_entries_append_only',
      timing: 'before',
      events: ['update', 'delete'],
      body: "RAISE EXCEPTION 'wallet ledger entries are append-only' USING ERRCODE = '55000'; RETURN OLD;",
    },
  ],
});
