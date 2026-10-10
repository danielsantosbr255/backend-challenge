import { Migration } from '@mikro-orm/migrations';

export class Migration20261010160000_pending_reference_retries extends Migration {
  override up(): void {
    this.addSql('alter table "wager_transactions" add column "reference_attempts" int not null default 0;');
    this.addSql('alter table "wager_transactions" add column "reference_next_attempt_at" timestamptz null;');
    this.addSql(`create index "wager_transactions_pending_reference_idx"
      on "wager_transactions" ("reference_next_attempt_at", "id")
      where "status" = 'PENDING_REFERENCE';`);
    this.addSql(`alter table "wager_transactions" add constraint "wager_transactions_reference_retry_check"
      check ("reference_attempts" >= 0 AND
        (("status" = 'PENDING_REFERENCE' AND "reference_next_attempt_at" IS NOT NULL) OR
         ("status" <> 'PENDING_REFERENCE' AND "reference_next_attempt_at" IS NULL)));`);
  }

  override down(): void {
    this.addSql('alter table "wager_transactions" drop constraint "wager_transactions_reference_retry_check";');
    this.addSql('drop index "wager_transactions_pending_reference_idx";');
    this.addSql('alter table "wager_transactions" drop column "reference_next_attempt_at";');
    this.addSql('alter table "wager_transactions" drop column "reference_attempts";');
  }
}
