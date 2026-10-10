import {
  ConnectionException,
  DeadlockException,
  EntityManager,
  LockMode,
  LockWaitTimeoutException,
  UniqueConstraintViolationException,
  type InferEntity,
} from '@mikro-orm/core';
import { Inject, Injectable } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';
import { TransientInfrastructureError } from '@/common/errors/transient-infrastructure.error';
import type { Wallet } from '@/modules/wallet/domain/wallet';
import type { WalletLedgerEntry } from '@/modules/wallet/domain/wallet-ledger-entry';
import type { WagerTransaction } from '@/modules/wager/domain/wager-transaction';
import {
  type StoredWagerResult,
  type WagerRepositoryInterface,
  type WagerUnitOfWork,
  type WagerReference,
} from './wager.interface';
import {
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
  toWagerReference,
  type OutboxEventData,
} from './wager.mappers';

@Injectable()
export class WagerRepository implements WagerRepositoryInterface, WagerUnitOfWork {
  private walletEntity: InferEntity<typeof WalletEntity> | undefined;
  private wagerEntity: InferEntity<typeof WagerTransactionEntity> | undefined;

  constructor(
    @Inject(EntityManager) private readonly em: EntityManager,
    private readonly transactionScoped = false,
  ) {}

  async transaction<T>(work: (tx: WagerUnitOfWork) => Promise<T>): Promise<T> {
    try {
      return await this.em.transactional((em) => work(new WagerRepository(em, true)));
    } catch (error: unknown) {
      if (error instanceof UniqueConstraintViolationException) {
        const constraint = readConstraint(error);
        if (constraint === 'wager_transactions_idempotency_unique') {
          throw new WagerReservationConflictError('IDEMPOTENCY');
        }
        if (constraint === 'wager_transactions_external_id_unique') {
          throw new WagerReservationConflictError('EXTERNAL_TRANSACTION');
        }
      }
      if (
        error instanceof ConnectionException || error instanceof DeadlockException ||
        error instanceof LockWaitTimeoutException
      ) {
        throw new TransientInfrastructureError();
      }
      throw error;
    }
  }

  async findByIdempotency(providerId: string, idempotencyKey: string): Promise<StoredWagerResult | undefined> {
    const em = this.transactionScoped ? this.em : this.em.fork();
    const entity = await em.findOne(WagerTransactionEntity, { providerId, idempotencyKey });
    return entity === null ? undefined : toStoredWagerResult(entity);
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
    const rows = await this.em.getConnection().execute<Array<{ payload_hash: string }>>(
      `INSERT INTO inbox_messages (consumer_name, message_id, payload_hash, received_at, processed_at)
       VALUES (?, ?, ?, current_timestamp, current_timestamp)
       ON CONFLICT (consumer_name, message_id) DO NOTHING
       RETURNING payload_hash`,
      [consumerName, messageId, payloadHash],
    );
    if (rows.length > 0) return true;

    const existing = await this.em.getConnection().execute<Array<{ payload_hash: string }>>(
      'SELECT payload_hash FROM inbox_messages WHERE consumer_name = ? AND message_id = ?',
      [consumerName, messageId],
    );
    if (existing[0]?.payload_hash !== payloadHash) throw new InboxMessageConflictError();
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

  async findReference(providerId: string, externalTransactionId: string): Promise<WagerReference | undefined> {
    const entity = await this.em.findOne(WagerTransactionEntity, { providerId, externalTransactionId });
    if (entity === null) {
      return undefined;
    }
    return toWagerReference(entity);
  }

  async persistResult(
    wallet: Wallet,
    transaction: WagerTransaction,
    ledgerEntry: WalletLedgerEntry | undefined,
    balance: { amount: string; currency: string },
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

  private enqueueEvent(
    transaction: WagerTransaction,
    wallet: Wallet,
    ledgerEntry: WalletLedgerEntry | undefined,
    balance: { amount: string; currency: string },
  ): void {
    const eventType = transaction.status === 'PROCESSED'
      ? 'WagerTransactionProcessed'
      : 'WagerTransactionRejected';
    const occurredAt = transaction.processedAt ?? new Date();
    const events: Array<Pick<OutboxEventData, 'eventId' | 'eventType' | 'data'>> = [
      {
        eventId: uuidv7(),
        eventType,
        data: {
          transactionId: transaction.id,
          providerId: transaction.providerId,
          externalTransactionId: transaction.externalTransactionId,
          status: transaction.status,
          ...(transaction.failureCode === undefined ? {} : { failureCode: transaction.failureCode }),
          balance,
        },
      },
    ];

    if (ledgerEntry !== undefined) {
      events.push({
        eventId: uuidv7(),
        eventType: 'WalletBalanceChanged',
        data: {
          walletId: wallet.id,
          transactionId: transaction.id,
          direction: ledgerEntry.direction,
          money: ledgerEntry.amount.toJSON(),
          balanceBefore: ledgerEntry.balanceBefore.toJSON(),
          balanceAfter: ledgerEntry.balanceAfter.toJSON(),
          walletVersion: wallet.version,
        },
      });
    }

    for (const event of events) {
      this.em.persist(this.em.create(OutboxMessageEntity, toOutboxEntityData({
        eventId: event.eventId,
        eventType: event.eventType,
        aggregateId: wallet.id,
        correlationId: transaction.externalTransactionId,
        occurredAt,
        data: event.data,
      })));
    }
  }
}

function readConstraint(error: UniqueConstraintViolationException): string | undefined {
  if ('constraint' in error && typeof error.constraint === 'string') {
    return error.constraint;
  }
  return undefined;
}
