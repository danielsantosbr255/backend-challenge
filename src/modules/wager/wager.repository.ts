import {
  EntityManager,
  LockMode,
  UniqueConstraintViolationException,
  type InferEntity,
} from '@mikro-orm/core';
import { Inject, Injectable } from '@nestjs/common';
import { MetricsService } from '@/common/observability/metrics.service';
import { isPersistenceLockConflict, rethrowPersistenceError } from '@/infrastructure/persistence/persistence-error';
import type { Wallet } from '@/modules/wallet/domain/wallet';
import type { WalletLedgerEntry } from '@/modules/wallet/domain/wallet-ledger-entry';
import type { WagerTransaction } from '@/modules/wager/domain/wager-transaction';
import {
  type StoredWagerResult,
  type WagerRepositoryInterface,
  type WagerUnitOfWork,
  type PendingReferenceClaim,
  type PendingReferenceRetry,
  type WagerTransactionQuery,
} from './wager.interface';
import {
  WagerAlreadyReversedError,
  InvalidWagerProcessingStateError,
  InvalidWagerUnitOfWorkStateError,
  InboxMessageConflictError,
  WagerReservationConflictError,
} from './wager.errors';
import { OutboxMessageEntity } from './entities/outbox-message.entity';
import { WalletLedgerEntryEntity } from '@/modules/wallet/entities/wallet-ledger-entry.entity';
import { WalletEntity } from '@/modules/wallet/entities/wallet.entity';
import { WagerTransactionEntity } from './entities/wager-transaction.entity';
import {
  toWalletBalanceEntityData,
  toWalletDomain,
  toLedgerEntryEntityData,
} from '@/modules/wallet/wallet.mappers';
import {
  toOutboxEntityData,
  toStoredWagerResult,
  toWagerEntityData,
  toWagerResultEntityData,
  toWagerDomain,
} from './wager.mappers';
import { createWagerEvents } from './wager.events';
import { InboxMessage } from './domain/inbox-message';

@Injectable()
export class WagerRepository implements WagerRepositoryInterface, WagerUnitOfWork {
  private walletEntity: InferEntity<typeof WalletEntity> | undefined;
  private wagerEntity: InferEntity<typeof WagerTransactionEntity> | undefined;
  private transactionScoped = false;

  constructor(@Inject(EntityManager) private readonly em: EntityManager, private readonly metrics: MetricsService) {}

  private forTransaction(em: EntityManager): WagerRepository {
    const repository = new WagerRepository(em, this.metrics);
    repository.transactionScoped = true;
    return repository;
  }

  async transaction<T>(work: (tx: WagerUnitOfWork) => Promise<T>): Promise<T> {
    try {
      return await this.em.transactional((em) => work(this.forTransaction(em)));
    } catch (error: unknown) {
      if (error instanceof UniqueConstraintViolationException) {
        const constraint = readConstraint(error);
        if (constraint === 'wager_transactions_idempotency_unique') {
          throw new WagerReservationConflictError('IDEMPOTENCY');
        }
        if (constraint === 'wager_transactions_external_id_unique') {
          throw new WagerReservationConflictError('EXTERNAL_TRANSACTION');
        }
        if (constraint === 'wager_transactions_processed_reversal_unique') {
          throw new WagerAlreadyReversedError();
        }
      }
      if (isPersistenceLockConflict(error)) this.metrics.recordLockConflict();
      rethrowPersistenceError(error);
    }
  }

  async findByIdempotency(providerId: string, idempotencyKey: string): Promise<StoredWagerResult | undefined> {
    const em = this.transactionScoped ? this.em : this.em.fork();
    const entity = await em.findOne(WagerTransactionEntity, { providerId, idempotencyKey }).catch(rethrowPersistenceError);
    return entity === null ? undefined : toStoredWagerResult(entity);
  }

  async findDuePendingReferenceIds(now: Date, limit: number): Promise<string[]> {
    const rows: Array<{ id: string }> = await this.em.fork().getConnection().execute<Array<{ id: string }>>(
      `SELECT id FROM wager_transactions
       WHERE status = 'PENDING_REFERENCE' AND reference_next_attempt_at <= ?
       ORDER BY reference_next_attempt_at, id
       LIMIT ?`,
      [now, limit],
    ).catch(rethrowPersistenceError);
    return rows.map(({ id }) => id);
  }

  async findTransaction(transactionId: string): Promise<WagerTransactionQuery | undefined> {
    const entity = await this.em.fork().findOne(WagerTransactionEntity, { id: transactionId }).catch(rethrowPersistenceError);
    return entity === null ? undefined : toWagerTransactionQuery(entity);
  }

  async findProviderTransaction(providerId: string, externalTransactionId: string): Promise<WagerTransactionQuery | undefined> {
    const entity = await this.em.fork().findOne(WagerTransactionEntity, { providerId, externalTransactionId }).catch(rethrowPersistenceError);
    return entity === null ? undefined : toWagerTransactionQuery(entity);
  }

  async walletExists(walletId: string): Promise<boolean> {
    return (await this.em.findOne(WalletEntity, { id: walletId }, { fields: ['id'] })) !== null;
  }

  async reserve(transaction: WagerTransaction): Promise<void> {
    this.wagerEntity = this.em.create(
      WagerTransactionEntity,
      toWagerEntityData(transaction, this.em.getReference(WalletEntity, transaction.walletId)),
    );
    this.em.persist(this.wagerEntity);
    await this.em.flush();
  }

  async receiveInbox(consumerName: string, messageId: string, payloadHash: string): Promise<boolean> {
    const message = InboxMessage.receive({ consumerName, messageId, payloadHash, receivedAt: new Date() });
    message.markProcessed(new Date());
    const rows = await this.em.getConnection().execute<Array<{ payload_hash: string }>>(
      `INSERT INTO inbox_messages (consumer_name, message_id, payload_hash, received_at, processed_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (consumer_name, message_id) DO NOTHING
       RETURNING payload_hash`,
      [message.consumerName, message.messageId, message.payloadHash, message.receivedAt, message.processedAt],
      'all', this.em.getTransactionContext(),
    );
    if (rows.length > 0) return true;

    const existing = await this.em.getConnection().execute<Array<{ payload_hash: string; received_at: Date; processed_at: Date | null }>>(
      'SELECT payload_hash, received_at, processed_at FROM inbox_messages WHERE consumer_name = ? AND message_id = ?',
      [consumerName, messageId], 'all', this.em.getTransactionContext(),
    );
    const row = existing[0];
    if (row === undefined) throw new InboxMessageConflictError();
    const received = InboxMessage.rehydrate({
      consumerName, messageId, payloadHash: row.payload_hash, receivedAt: new Date(row.received_at),
      ...(row.processed_at === null ? {} : { processedAt: new Date(row.processed_at) }),
    });
    if (received.payloadHash !== payloadHash || !received.isProcessed()) throw new InboxMessageConflictError();
    return false;
  }

  async lockWallet(walletId: string): Promise<Wallet | undefined> {
    const entity = await this.em.findOne(
      WalletEntity,
      { id: walletId },
      { lockMode: LockMode.PESSIMISTIC_WRITE },
    );
    if (entity === null) {
      return undefined;
    }
    this.walletEntity = entity;
    return toWalletDomain(entity);
  }

  async findReference(providerId: string, externalTransactionId: string): Promise<WagerTransaction | undefined> {
    const entity = await this.em.findOne(WagerTransactionEntity, { providerId, externalTransactionId });
    if (entity === null) {
      return undefined;
    }
    return toWagerDomain(entity);
  }

  async findProcessedReversal(referenceTransactionId: string, kind: 'REFUND' | 'ROLLBACK'): Promise<boolean> {
    return (await this.em.findOne(WagerTransactionEntity, {
      referenceTransaction: referenceTransactionId,
      kind,
      status: 'PROCESSED',
    }, { fields: ['id'] })) !== null;
  }

  async claimPendingReference(transactionId: string, now: Date): Promise<PendingReferenceClaim | undefined> {
    const rows = await this.em.getConnection().execute<Array<{ id: string }>>(
      `SELECT id FROM wager_transactions
       WHERE id = ? AND status = 'PENDING_REFERENCE' AND reference_next_attempt_at <= ?
       FOR UPDATE SKIP LOCKED`,
      [transactionId, now], 'all', this.em.getTransactionContext(),
    );
    const claim = rows[0];
    if (claim === undefined) return undefined;

    const attempts = await this.em.getConnection().execute<Array<{ reference_attempts: number }>>(
      `UPDATE wager_transactions SET reference_attempts = reference_attempts + 1
       WHERE id = ? AND status = 'PENDING_REFERENCE' RETURNING reference_attempts`,
      [claim.id], 'all', this.em.getTransactionContext(),
    );
    const referenceAttempts = attempts[0]?.reference_attempts;
    if (referenceAttempts === undefined) return undefined;

    const entity = await this.em.findOne(WagerTransactionEntity, { id: claim.id });
    if (entity === null) return undefined;
    this.wagerEntity = entity;
    return { transaction: toWagerDomain(entity), attempts: referenceAttempts };
  }

  async schedulePendingReferenceRetry(transactionId: string, retry: PendingReferenceRetry): Promise<void> {
    await this.em.getConnection().execute(
      `UPDATE wager_transactions
       SET reference_attempts = ?, reference_next_attempt_at = ?
       WHERE id = ? AND status = 'PENDING_REFERENCE'`,
      [retry.attempts, retry.nextAttemptAt, transactionId], 'all', this.em.getTransactionContext(),
    );
  }

  async persistResult(
    wallet: Wallet,
    transaction: WagerTransaction,
    ledgerEntry: WalletLedgerEntry | undefined,
    balance: { amount: string; currency: string },
    pendingReferenceRetry?: PendingReferenceRetry,
  ): Promise<void> {
    if (this.walletEntity === undefined || this.wagerEntity === undefined) {
      throw new InvalidWagerUnitOfWorkStateError();
    }

    Object.assign(this.walletEntity, toWalletBalanceEntityData(wallet, balance));
    Object.assign(
      this.wagerEntity,
      toWagerResultEntityData(
        transaction,
        balance,
        transaction.referenceTransactionId === undefined
          ? null
          : this.em.getReference(WagerTransactionEntity, transaction.referenceTransactionId),
        pendingReferenceRetry,
      ),
    );

    if (ledgerEntry !== undefined) {
      this.em.persist(
        this.em.create(
          WalletLedgerEntryEntity,
          toLedgerEntryEntityData(ledgerEntry, this.walletEntity, this.wagerEntity),
        ),
      );
    }

    this.enqueueEvent(transaction, wallet, ledgerEntry, balance);
    await this.em.flush();
  }

  async persistFailure(
    transaction: WagerTransaction,
    balance: { amount: string; currency: string },
  ): Promise<boolean> {
    try {
      return await this.em.transactional(async (em) => {
        if (await em.findOne(WagerTransactionEntity, { id: transaction.id }) !== null) return false;
        const entity = em.create(
          WagerTransactionEntity,
          toWagerEntityData(transaction, em.getReference(WalletEntity, transaction.walletId), balance),
        );
        em.persist(entity);
        await em.flush();
        return true;
      });
    } catch (error: unknown) {
      if (error instanceof UniqueConstraintViolationException) return false;
      if (isPersistenceLockConflict(error)) this.metrics.recordLockConflict();
      rethrowPersistenceError(error);
    }
  }

  private enqueueEvent(
    transaction: WagerTransaction,
    wallet: Wallet,
    ledgerEntry: WalletLedgerEntry | undefined,
    balance: { amount: string; currency: string },
  ): void {
    const events = createWagerEvents(transaction, wallet, ledgerEntry, balance);
    for (const event of events) {
      this.em.persist(this.em.create(OutboxMessageEntity, toOutboxEntityData(event)));
    }
  }
}

function readConstraint(error: UniqueConstraintViolationException): string | undefined {
  if ('constraint' in error && typeof error.constraint === 'string') {
    return error.constraint;
  }
  return undefined;
}

function toWagerTransactionQuery(entity: InferEntity<typeof WagerTransactionEntity>): WagerTransactionQuery {
  return {
    transactionId: entity.id,
    providerId: entity.providerId,
    externalTransactionId: entity.externalTransactionId,
    walletId: entity.wallet.id,
    kind: entity.kind,
    status: entity.status,
    money: { amount: entity.amount, currency: entity.currency },
    ...(entity.referenceExternalTransactionId === null ? {} : { referenceExternalTransactionId: entity.referenceExternalTransactionId }),
    ...(entity.failureCode === null ? {} : { failureCode: entity.failureCode }),
    ...(entity.responseBalanceAmount === null || entity.responseBalanceCurrency === null
      ? {}
      : { responseBalance: { amount: entity.responseBalanceAmount, currency: entity.responseBalanceCurrency } }),
    createdAt: entity.createdAt,
    ...(entity.processedAt === null ? {} : { processedAt: entity.processedAt }),
  };
}
