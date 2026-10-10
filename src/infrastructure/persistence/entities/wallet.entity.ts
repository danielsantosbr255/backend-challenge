import { defineEntity, p } from '@mikro-orm/postgresql';

export const WalletEntity = defineEntity({
  name: 'Wallet',
  tableName: 'wallets',
  properties: {
    id: p.uuid().primary(),
    playerId: p.uuid().fieldName('player_id'),
    currency: p.string().columnType('char(3)'),
    balance: p.decimal('string').precision(18).scale(2).default('0.00'),
    version: p.integer().default(1),
    createdAt: p.datetime().fieldName('created_at').columnType('timestamptz').defaultRaw('current_timestamp'),
    updatedAt: p.datetime().fieldName('updated_at').columnType('timestamptz').defaultRaw('current_timestamp'),
  },
  uniques: [{ name: 'wallets_player_currency_unique', properties: ['playerId', 'currency'] }],
  checks: [
    {
      name: 'wallets_currency_format_check',
      expression: (columns) => `${columns.currency} ~ '^[A-Z]{3}$'`,
    },
    {
      name: 'wallets_balance_check',
      expression: (columns) => `${columns.balance} >= 0 AND ${columns.balance} <> 'NaN'::numeric`,
    },
    {
      name: 'wallets_version_check',
      expression: (columns) => `${columns.version} >= 1`,
    },
  ],
});
