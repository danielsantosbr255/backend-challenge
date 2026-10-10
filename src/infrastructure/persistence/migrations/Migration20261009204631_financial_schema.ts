import { Migration } from '@mikro-orm/migrations';

export class Migration20261009204631_financial_schema extends Migration {

  override name = 'Migration20261009204631_financial_schema';

  override up(): void | Promise<void> {
    this.addSql(`create table "inbox_messages" ("consumer_name" varchar(100) not null, "message_id" varchar(255) not null, "payload_hash" char(64) not null, "received_at" timestamptz not null default current_timestamp, "processed_at" timestamptz null, primary key ("consumer_name", "message_id"));`);

    this.addSql(`create table "outbox_messages" ("id" uuid not null, "aggregate_id" uuid not null, "event_type" varchar(100) not null, "payload" jsonb not null, "occurred_at" timestamptz not null, "attempts" int not null default 0, "next_attempt_at" timestamptz not null default current_timestamp, "claimed_by" varchar(255) null, "claimed_until" timestamptz null, "published_at" timestamptz null, primary key ("id"));`);
    this.addSql(`create index "outbox_messages_pending_idx" on "outbox_messages" ("next_attempt_at", "occurred_at", "id") where "published_at" is null;`);

    this.addSql(`create table "wallets" ("id" uuid not null, "player_id" uuid not null, "currency" char(3) not null, "balance" numeric(18,2) not null default '0.00', "version" int not null default 1, "created_at" timestamptz not null default current_timestamp, "updated_at" timestamptz not null default current_timestamp, primary key ("id"));`);
    this.addSql(`alter table "wallets" add constraint "wallets_player_currency_unique" unique ("player_id", "currency");`);

    this.addSql(`create table "wager_transactions" ("id" uuid not null, "provider_id" varchar(100) not null, "external_transaction_id" varchar(255) not null, "idempotency_key" varchar(255) not null, "payload_hash" char(64) not null, "wallet_id" uuid not null, "player_id" uuid not null, "round_id" varchar(255) not null, "game_id" varchar(255) not null, "kind" varchar(16) not null, "amount" numeric(18,2) not null, "currency" char(3) not null, "reference_external_transaction_id" varchar(255) null, "reference_transaction_id" uuid null, "status" varchar(24) not null, "failure_code" varchar(64) null, "processed_at" timestamptz null, "response_balance_amount" numeric(18,2) null, "response_balance_currency" char(3) null, "created_at" timestamptz not null default current_timestamp, primary key ("id"));`);
    this.addSql(`create index "wager_transactions_wallet_created_idx" on "wager_transactions" ("wallet_id" ASC, "created_at" DESC, "id" DESC);`);
    this.addSql(`create index "wager_transactions_reference_external_idx" on "wager_transactions" ("provider_id", "reference_external_transaction_id") where "reference_external_transaction_id" is not null;`);
    this.addSql(`alter table "wager_transactions" add constraint "wager_transactions_idempotency_unique" unique ("provider_id", "idempotency_key");`);
    this.addSql(`alter table "wager_transactions" add constraint "wager_transactions_external_id_unique" unique ("provider_id", "external_transaction_id");`);
    this.addSql(`create unique index "wager_transactions_processed_reversal_unique" on "wager_transactions" ("provider_id", "reference_transaction_id", "kind") where "status" = 'PROCESSED' and "kind" in ('REFUND', 'ROLLBACK');`);

    this.addSql(`create table "wallet_ledger_entries" ("id" uuid not null, "wallet_id" uuid not null, "transaction_id" uuid not null, "direction" varchar(8) not null, "amount" numeric(18,2) not null, "balance_before" numeric(18,2) not null, "balance_after" numeric(18,2) not null, "created_at" timestamptz not null default current_timestamp, primary key ("id"));`);
    this.addSql(`create index "wallet_ledger_entries_wallet_created_idx" on "wallet_ledger_entries" ("wallet_id" ASC, "created_at" DESC, "id" DESC);`);
    this.addSql(`alter table "wallet_ledger_entries" add constraint "wallet_ledger_entries_wallet_transaction_unique" unique ("wallet_id", "transaction_id");`);

    this.addSql(`alter table "inbox_messages" add constraint "inbox_messages_payload_hash_check" check (payload_hash ~ '^[0-9a-f]{64}\$');`);

    this.addSql(`alter table "outbox_messages" add constraint "outbox_messages_attempts_check" check (attempts >= 0);`);
    this.addSql(`alter table "outbox_messages" add constraint "outbox_messages_payload_object_check" check (jsonb_typeof(payload) = 'object');`);
    this.addSql(`alter table "outbox_messages" add constraint "outbox_messages_claim_check" check ((claimed_by IS NULL) = (claimed_until IS NULL));`);

    this.addSql(`alter table "wallets" add constraint "wallets_currency_format_check" check (currency ~ '^[A-Z]{3}\$');`);
    this.addSql(`alter table "wallets" add constraint "wallets_balance_check" check (balance >= 0 AND balance <> 'NaN'::numeric);`);
    this.addSql(`alter table "wallets" add constraint "wallets_version_check" check (version >= 1);`);

    this.addSql(`alter table "wager_transactions" add constraint "wager_transactions_wallet_id_foreign" foreign key ("wallet_id") references "wallets" ("id") on delete restrict;`);
    this.addSql(`alter table "wager_transactions" add constraint "wager_transactions_reference_transaction_id_foreign" foreign key ("reference_transaction_id") references "wager_transactions" ("id") on delete restrict;`);
    this.addSql(`alter table "wager_transactions" add constraint "wager_transactions_kind_check" check (kind IN ('OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK'));`);
    this.addSql(`alter table "wager_transactions" add constraint "wager_transactions_status_check" check (status IN ('PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED'));`);
    this.addSql(`alter table "wager_transactions" add constraint "wager_transactions_amount_check" check (amount >= 0 AND amount <> 'NaN'::numeric);`);
    this.addSql(`alter table "wager_transactions" add constraint "wager_transactions_currency_format_check" check (currency ~ '^[A-Z]{3}\$');`);
    this.addSql(`alter table "wager_transactions" add constraint "wager_transactions_payload_hash_check" check (payload_hash ~ '^[0-9a-f]{64}\$');`);
    this.addSql(`alter table "wager_transactions" add constraint "wager_transactions_response_balance_check" check ((response_balance_amount IS NULL AND response_balance_currency IS NULL) OR (response_balance_amount IS NOT NULL AND response_balance_currency IS NOT NULL AND response_balance_amount >= 0 AND response_balance_amount <> 'NaN'::numeric AND response_balance_currency ~ '^[A-Z]{3}\$'));`);
    this.addSql(`alter table "wager_transactions" add constraint "wager_transactions_processed_reversal_reference_check" check (status <> 'PROCESSED' OR kind NOT IN ('REFUND', 'ROLLBACK') OR reference_transaction_id IS NOT NULL);`);

    this.addSql(`alter table "wallet_ledger_entries" add constraint "wallet_ledger_entries_wallet_id_foreign" foreign key ("wallet_id") references "wallets" ("id") on delete restrict;`);
    this.addSql(`alter table "wallet_ledger_entries" add constraint "wallet_ledger_entries_transaction_id_foreign" foreign key ("transaction_id") references "wager_transactions" ("id") on delete restrict;`);
    this.addSql(`alter table "wallet_ledger_entries" add constraint "wallet_ledger_entries_direction_check" check (direction IN ('CREDIT', 'DEBIT'));`);
    this.addSql(`alter table "wallet_ledger_entries" add constraint "wallet_ledger_entries_amount_check" check (amount > 0 AND amount <> 'NaN'::numeric);`);
    this.addSql(`alter table "wallet_ledger_entries" add constraint "wallet_ledger_entries_balance_values_check" check (balance_before >= 0 AND balance_before <> 'NaN'::numeric AND balance_after >= 0 AND balance_after <> 'NaN'::numeric);`);
    this.addSql(`alter table "wallet_ledger_entries" add constraint "wallet_ledger_entries_arithmetic_check" check ((direction = 'CREDIT' AND balance_after = balance_before + amount) OR (direction = 'DEBIT' AND balance_after = balance_before - amount));`);
    this.addSql(`create or replace function "wallet_ledger_entries_wallet_ledger_entries_append_only_fn"() returns trigger as \$\$ begin RAISE EXCEPTION 'wallet ledger entries are append-only' USING ERRCODE = '55000'; RETURN OLD; end; \$\$ language plpgsql;`);
    this.addSql(`create trigger "wallet_ledger_entries_append_only" BEFORE UPDATE OR DELETE on "wallet_ledger_entries" for each ROW execute function "wallet_ledger_entries_wallet_ledger_entries_append_only_fn"();`);
  }

  override down(): void | Promise<void> {
    this.addSql(`alter table "wager_transactions" drop constraint "wager_transactions_wallet_id_foreign";`);
    this.addSql(`alter table "wallet_ledger_entries" drop constraint "wallet_ledger_entries_wallet_id_foreign";`);
    this.addSql(`alter table "wager_transactions" drop constraint "wager_transactions_reference_transaction_id_foreign";`);
    this.addSql(`alter table "wallet_ledger_entries" drop constraint "wallet_ledger_entries_transaction_id_foreign";`);

    this.addSql(`drop table if exists "inbox_messages" cascade;`);
    this.addSql(`drop table if exists "outbox_messages" cascade;`);
    this.addSql(`drop table if exists "wallets" cascade;`);
    this.addSql(`drop table if exists "wager_transactions" cascade;`);
    this.addSql(`drop trigger if exists "wallet_ledger_entries_append_only" on "wallet_ledger_entries";`);
    this.addSql(`drop function if exists "wallet_ledger_entries_wallet_ledger_entries_append_only_fn"();`);
    this.addSql(`drop table if exists "wallet_ledger_entries" cascade;`);
  }

}
