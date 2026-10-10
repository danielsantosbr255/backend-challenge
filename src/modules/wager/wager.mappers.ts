import type { InferEntity } from '@mikro-orm/core';
import type { StoredWagerResult, WagerReference } from './wager.interface';
import type { WagerTransaction } from './domain/wager-transaction';
import { OutboxMessageEntity } from './entities/outbox-message.entity';
import { WagerTransactionEntity } from './entities/wager-transaction.entity';
import { WalletEntity } from '@/modules/wallet/entities/wallet.entity';
import { InvalidPersistedWagerResultError } from './wager.errors';

type WagerOrmEntity = InferEntity<typeof WagerTransactionEntity>;
type WalletOrmEntity = InferEntity<typeof WalletEntity>;
type OutboxOrmEntity = InferEntity<typeof OutboxMessageEntity>;

export function toWagerEntityData(
  transaction: WagerTransaction,
  wallet: WalletOrmEntity,
  responseBalance?: { amount: string; currency: string },
) {
  return {
    id: transaction.id,
    providerId: transaction.providerId,
    externalTransactionId: transaction.externalTransactionId,
    idempotencyKey: transaction.idempotencyKey,
    payloadHash: transaction.payloadHash,
    wallet,
    playerId: transaction.playerId,
    roundId: transaction.roundId,
    gameId: transaction.gameId,
    kind: transaction.kind,
    amount: transaction.money.toJSON().amount,
    currency: transaction.money.currency,
    referenceExternalTransactionId: transaction.referenceExternalTransactionId ?? null,
    referenceTransaction: null,
    status: transaction.status,
    failureCode: transaction.failureCode ?? null,
    processedAt: transaction.processedAt ?? null,
    responseBalanceAmount: responseBalance?.amount ?? null,
    responseBalanceCurrency: responseBalance?.currency ?? null,
    createdAt: transaction.createdAt,
  } satisfies Partial<WagerOrmEntity>;
}

export function toWagerResultEntityData(
  transaction: WagerTransaction,
  balance: { amount: string; currency: string },
  referenceTransaction: WagerOrmEntity | null,
) {
  return {
    status: transaction.status,
    failureCode: transaction.failureCode ?? null,
    processedAt: transaction.processedAt ?? null,
    referenceTransaction,
    responseBalanceAmount: balance.amount,
    responseBalanceCurrency: balance.currency,
  } satisfies Partial<WagerOrmEntity>;
}

export function toStoredWagerResult(entity: WagerOrmEntity): StoredWagerResult {
  if (
    (entity.status !== 'PROCESSED' && entity.status !== 'REJECTED') ||
    entity.responseBalanceAmount === null ||
    entity.responseBalanceCurrency === null
  ) {
    throw new InvalidPersistedWagerResultError();
  }
  return {
    transactionId: entity.id,
    providerId: entity.providerId,
    externalTransactionId: entity.externalTransactionId,
    idempotencyKey: entity.idempotencyKey,
    payloadHash: entity.payloadHash,
    status: entity.status,
    failureCode: entity.failureCode ?? undefined,
    responseBalance: {
      amount: entity.responseBalanceAmount,
      currency: entity.responseBalanceCurrency,
    },
  };
}

export function toWagerReference(entity: WagerOrmEntity): WagerReference {
  return {
    id: entity.id,
    providerId: entity.providerId,
    externalTransactionId: entity.externalTransactionId,
    playerId: entity.playerId,
    walletId: entity.wallet.id,
    roundId: entity.roundId,
    kind: entity.kind,
    status: entity.status,
    currency: entity.currency,
  };
}

export interface OutboxEventData {
  eventId: string;
  eventType: string;
  aggregateId: string;
  correlationId: string;
  occurredAt: Date;
  data: Record<string, unknown>;
}

export function toOutboxEntityData(event: OutboxEventData) {
  return {
    id: event.eventId,
    aggregateId: event.aggregateId,
    eventType: event.eventType,
    payload: {
      eventId: event.eventId,
      eventType: event.eventType,
      aggregateId: event.aggregateId,
      correlationId: event.correlationId,
      occurredAt: event.occurredAt.toISOString(),
      version: 1,
      data: event.data,
    },
    occurredAt: event.occurredAt,
    attempts: 0,
    nextAttemptAt: event.occurredAt,
    claimedBy: null,
    claimedUntil: null,
    publishedAt: null,
  } satisfies Partial<OutboxOrmEntity>;
}
