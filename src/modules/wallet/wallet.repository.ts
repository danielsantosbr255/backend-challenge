import { EntityManager, UniqueConstraintViolationException } from '@mikro-orm/core';
import { Inject, Injectable } from '@nestjs/common';
import type {
  LedgerCursor,
  LedgerPage,
  LedgerRecord,
  OpeningArtifacts,
  WalletReconciliation,
  WalletRepositoryInterface,
} from './wallet.interface';
import { WalletAlreadyExistsError } from './wallet.errors';
import type { Wallet } from './domain/wallet';
import { WalletLedgerEntryEntity } from './entities/wallet-ledger-entry.entity';
import { WalletEntity } from './entities/wallet.entity';
import { WagerTransactionEntity } from '@/modules/wager/entities/wager-transaction.entity';
import { toLedgerEntryEntityData, toWalletDomain, toWalletEntityData } from './wallet.mappers';
import { toWagerEntityData } from '@/modules/wager/wager.mappers';
import { Money } from './domain/money';

@Injectable()
export class WalletRepository implements WalletRepositoryInterface {
  constructor(@Inject(EntityManager) private readonly em: EntityManager) {}

  async persistNewWallet(wallet: Wallet, opening?: OpeningArtifacts): Promise<void> {
    try {
      await this.em.transactional(async (em) => {
        const walletEntity = em.create(WalletEntity, toWalletEntityData(wallet));
        em.persist(walletEntity);

        if (opening !== undefined) {
          const transactionEntity = em.create(
            WagerTransactionEntity,
            toWagerEntityData(opening.transaction, walletEntity, wallet.balance.toJSON()),
          );
          const ledgerEntryEntity = em.create(
            WalletLedgerEntryEntity,
            toLedgerEntryEntityData(opening.ledgerEntry, walletEntity, transactionEntity),
          );
          em.persist(transactionEntity);
          em.persist(ledgerEntryEntity);
        }

        await em.flush();
      });
    } catch (error: unknown) {
      if (isWalletUniquenessConflict(error)) {
        throw new WalletAlreadyExistsError();
      }
      throw error;
    }
  }

  async findById(walletId: string): Promise<Wallet | undefined> {
    const entity = await this.em.fork().findOne(WalletEntity, { id: walletId });
    return entity === null ? undefined : toWalletDomain(entity);
  }

  async findLedger(walletId: string, cursor: LedgerCursor | undefined, limit: number): Promise<LedgerPage> {
    type LedgerRow = Omit<LedgerRecord, 'currency' | 'createdAt'> & { wallet_currency: string; createdAt: string };
    const rows: LedgerRow[] = await this.em.getConnection().execute<LedgerRow[]>(
      `SELECT e.id, e.transaction_id AS "transactionId", e.direction, e.amount::text,
              e.balance_before::text AS "balanceBefore", e.balance_after::text AS "balanceAfter",
              e.created_at::text AS "createdAt", w.currency AS wallet_currency
       FROM wallet_ledger_entries e JOIN wallets w ON w.id = e.wallet_id
       WHERE e.wallet_id = ? AND (?::timestamptz IS NULL OR (e.created_at, e.id) < (?, ?::uuid))
       ORDER BY e.created_at DESC, e.id DESC LIMIT ?`,
      [walletId, cursor?.createdAt ?? null, cursor?.createdAt ?? null, cursor?.id ?? null, limit + 1],
    );
    const hasMore = rows.length > limit;
    const entries = rows.slice(0, limit).map((row: LedgerRow) => {
      const { wallet_currency, ...entry } = row;
      return { ...entry, createdAt: new Date(entry.createdAt), currency: wallet_currency };
    });
    const last = rows.slice(0, limit).at(-1);
    return {
      entries,
      ...(hasMore && last !== undefined ? { nextCursor: encodeLedgerCursor(last.createdAt, last.id) } : {}),
    };
  }

  async reconcile(walletId: string): Promise<WalletReconciliation | undefined> {
    const rows = await this.em.getConnection().execute<Array<{
      wallet_id: string;
      currency: string;
      stored_balance: string;
      credits: string | null;
      debits: string | null;
      checked_entries: number;
    }>>(
      `SELECT w.id AS wallet_id, w.currency, w.balance::text AS stored_balance,
              COALESCE(SUM(e.amount) FILTER (WHERE e.direction = 'CREDIT'), 0)::text AS credits,
              COALESCE(SUM(e.amount) FILTER (WHERE e.direction = 'DEBIT'), 0)::text AS debits,
              COUNT(e.id)::int AS checked_entries
       FROM wallets w LEFT JOIN wallet_ledger_entries e ON e.wallet_id = w.id
       WHERE w.id = ? GROUP BY w.id`,
      [walletId],
    );
    const row = rows[0];
    if (row === undefined) return undefined;
    const calculated = Money.from({ amount: row.credits ?? '0.00', currency: row.currency })
      .subtract(Money.from({ amount: row.debits ?? '0.00', currency: row.currency }));
    return {
      walletId: row.wallet_id,
      storedBalance: { amount: row.stored_balance, currency: row.currency },
      calculatedBalance: calculated.toJSON(),
      checkedEntries: row.checked_entries,
    };
  }
}

function encodeLedgerCursor(createdAt: string, id: string): string {
  return Buffer.from(JSON.stringify({ createdAt, id })).toString('base64url');
}

function isWalletUniquenessConflict(error: unknown): boolean {
  return (
    error instanceof UniqueConstraintViolationException &&
    'constraint' in error &&
    error.constraint === 'wallets_player_currency_unique'
  );
}
