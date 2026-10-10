import type { InferEntity } from '@mikro-orm/core';
import type { PendingReferenceRetry, StoredWagerResult } from './wager.interface';
import { WagerTransaction } from './domain/wager-transaction';
import { OutboxMessageEntity } from './entities/outbox-message.entity';
import { WagerTransactionEntity } from './entities/wager-transaction.entity';
import { WalletEntity } from '@/modules/wallet/entities/wallet.entity';
import { InvalidPersistedWagerResultError } from './wager.errors';
import type { IntegrationEvent } from './domain/integration-event';
import { OutboxMessage } from './domain/outbox-message';

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
    referenceAttempts: 0,
    referenceNextAttemptAt: null,
    createdAt: transaction.createdAt,
  } satisfies Partial<WagerOrmEntity>;
}

export function toWagerResultEntityData(
  transaction: WagerTransaction,
  balance: { amount: string; currency: string },
  referenceTransaction: WagerOrmEntity | null,
  pendingReferenceRetry?: PendingReferenceRetry,
) {
  return {
    status: transaction.status,
    failureCode: transaction.failureCode ?? null,
    processedAt: transaction.processedAt ?? null,
    referenceTransaction,
    responseBalanceAmount: balance.amount,
    responseBalanceCurrency: balance.currency,
    referenceNextAttemptAt: pendingReferenceRetry?.nextAttemptAt ?? null,
    ...(pendingReferenceRetry === undefined ? {} : { referenceAttempts: pendingReferenceRetry.attempts }),
  } satisfies Partial<WagerOrmEntity>;
}

export function toStoredWagerResult(entity: WagerOrmEntity): StoredWagerResult {
  if (
    (entity.status !== 'PROCESSED' && entity.status !== 'REJECTED' && entity.status !== 'PENDING_REFERENCE' && entity.status !== 'FAILED') ||
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

export function toWagerDomain(entity: WagerOrmEntity): WagerTransaction {
  return WagerTransaction.rehydrate({
    id: entity.id,
    providerId: entity.providerId,
    externalTransactionId: entity.externalTransactionId,
    idempotencyKey: entity.idempotencyKey,
    payloadHash: entity.payloadHash,
    walletId: entity.wallet.id,
    playerId: entity.playerId,
    roundId: entity.roundId,
    gameId: entity.gameId,
    kind: entity.kind,
    money: { amount: entity.amount, currency: entity.currency },
    ...(entity.referenceExternalTransactionId === null
      ? {}
      : { referenceExternalTransactionId: entity.referenceExternalTransactionId }),
    createdAt: entity.createdAt,
    status: entity.status,
    ...(entity.referenceTransaction === null ? {} : { referenceTransactionId: entity.referenceTransaction.id }),
    ...(entity.failureCode === null ? {} : { failureCode: entity.failureCode }),
    ...(entity.processedAt === null ? {} : { processedAt: entity.processedAt }),
  });
}

export function toOutboxEntityData(event: IntegrationEvent<Record<string, unknown>>) {
  const message = OutboxMessage.enqueue(event);
  return {
    id: message.id,
    aggregateId: message.aggregateId,
    eventType: message.eventType,
    payload: message.payload,
    occurredAt: message.occurredAt,
    attempts: message.attempts,
    nextAttemptAt: message.nextAttemptAt,
    claimedBy: null,
    claimedUntil: null,
    publishedAt: null,
  } satisfies Partial<OutboxOrmEntity>;
}
