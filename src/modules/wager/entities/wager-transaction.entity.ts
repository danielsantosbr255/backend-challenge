import { defineEntity, p } from '@mikro-orm/postgresql';
import { WalletEntity } from '@/modules/wallet/entities/wallet.entity';
import type { InferEntity } from '@mikro-orm/core';

export type WagerKind = 'OPENING' | 'BET' | 'WIN' | 'LOSS' | 'REFUND' | 'ROLLBACK';
export type WagerStatus = 'PENDING' | 'PENDING_REFERENCE' | 'PROCESSED' | 'REJECTED' | 'FAILED';

export class WagerTransactionOrmEntity {
  declare id: string;
  declare providerId: string;
  declare externalTransactionId: string;
  declare idempotencyKey: string;
  declare payloadHash: string;
  declare wallet: InferEntity<typeof WalletEntity>;
  declare playerId: string;
  declare roundId: string;
  declare gameId: string;
  declare kind: WagerKind;
  declare amount: string;
  declare currency: string;
  declare referenceExternalTransactionId: string | null;
  declare referenceTransaction: WagerTransactionOrmEntity | null;
  declare status: WagerStatus;
  declare failureCode: string | null;
  declare processedAt: Date | null;
  declare responseBalanceAmount: string | null;
  declare responseBalanceCurrency: string | null;
  declare createdAt: Date;
}

export const WagerTransactionEntity = defineEntity({
  name: 'WagerTransaction',
  class: WagerTransactionOrmEntity,
  tableName: 'wager_transactions',
  properties: {
    id: p.uuid().primary(),
    providerId: p.string().fieldName('provider_id').length(100),
    externalTransactionId: p.string().fieldName('external_transaction_id').length(255),
    idempotencyKey: p.string().fieldName('idempotency_key').length(255),
    payloadHash: p.string().fieldName('payload_hash').columnType('char(64)'),
    wallet: () => p.manyToOne(WalletEntity).fieldName('wallet_id').deleteRule('restrict'),
    playerId: p.uuid().fieldName('player_id'),
    roundId: p.string().fieldName('round_id').length(255),
    gameId: p.string().fieldName('game_id').length(255),
    kind: p.string().$type<WagerKind>().length(16),
    amount: p.decimal('string').precision(18).scale(2),
    currency: p.string().columnType('char(3)'),
    referenceExternalTransactionId: p.string().fieldName('reference_external_transaction_id').length(255).nullable(),
    referenceTransaction: () => p.manyToOne(WagerTransactionOrmEntity).fieldName('reference_transaction_id').deleteRule('restrict').nullable(),
    status: p.string().$type<WagerStatus>().length(24),
    failureCode: p.string().fieldName('failure_code').length(64).nullable(),
    processedAt: p.datetime().fieldName('processed_at').columnType('timestamptz').nullable(),
    responseBalanceAmount: p.decimal('string').fieldName('response_balance_amount').precision(18).scale(2).nullable(),
    responseBalanceCurrency: p.string().fieldName('response_balance_currency').columnType('char(3)').nullable(),
    createdAt: p.datetime().fieldName('created_at').columnType('timestamptz').defaultRaw('current_timestamp'),
  },
  uniques: [
    { name: 'wager_transactions_idempotency_unique', properties: ['providerId', 'idempotencyKey'] },
    { name: 'wager_transactions_external_id_unique', properties: ['providerId', 'externalTransactionId'] },
    {
      name: 'wager_transactions_processed_reversal_unique',
      properties: ['providerId', 'referenceTransaction', 'kind'],
      where: { status: 'PROCESSED', kind: { $in: ['REFUND', 'ROLLBACK'] } },
    },
  ],
  indexes: [
    {
      name: 'wager_transactions_wallet_created_idx',
      columns: [
        { name: 'wallet', sort: 'ASC' },
        { name: 'createdAt', sort: 'DESC' },
        { name: 'id', sort: 'DESC' },
      ],
    },
    {
      name: 'wager_transactions_reference_external_idx',
      properties: ['providerId', 'referenceExternalTransactionId'],
      where: { referenceExternalTransactionId: { $ne: null } },
    },
  ],
  checks: [
    {
      name: 'wager_transactions_kind_check',
      expression: (columns) => `${columns.kind} IN ('OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK')`,
    },
    {
      name: 'wager_transactions_status_check',
      expression: (columns) => `${columns.status} IN ('PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED')`,
    },
    {
      name: 'wager_transactions_amount_check',
      expression: (columns) => `${columns.amount} >= 0 AND ${columns.amount} <> 'NaN'::numeric`,
    },
    {
      name: 'wager_transactions_currency_format_check',
      expression: (columns) => `${columns.currency} ~ '^[A-Z]{3}$'`,
    },
    {
      name: 'wager_transactions_payload_hash_check',
      expression: (columns) => `${columns.payloadHash} ~ '^[0-9a-f]{64}$'`,
    },
    {
      name: 'wager_transactions_response_balance_check',
      expression: (columns) =>
        `(${columns.responseBalanceAmount} IS NULL AND ${columns.responseBalanceCurrency} IS NULL) OR ` +
        `(${columns.responseBalanceAmount} IS NOT NULL AND ${columns.responseBalanceCurrency} IS NOT NULL ` +
        `AND ${columns.responseBalanceAmount} >= 0 AND ${columns.responseBalanceAmount} <> 'NaN'::numeric ` +
        `AND ${columns.responseBalanceCurrency} ~ '^[A-Z]{3}$')`,
    },
    {
      name: 'wager_transactions_processed_reversal_reference_check',
      expression: (columns) =>
        `${columns.status} <> 'PROCESSED' OR ${columns.kind} NOT IN ('REFUND', 'ROLLBACK') ` +
        `OR ${columns.referenceTransaction} IS NOT NULL`,
    },
  ],
});
