import { Inject, Injectable } from '@nestjs/common';
import { MetricsService } from '@/common/observability/metrics.service';
import { v7 as uuidv7 } from 'uuid';
import { TransientInfrastructureError } from '@/common/errors/transient-infrastructure.error';
import { WagerTransaction } from '../domain/wager-transaction';
import { createCanonicalWagerHash } from '../wager.utils';
import {
  WAGER_REPOSITORY,
  type StoredWagerResult,
  type WagerIngressContext,
  type WagerRepositoryInterface,
} from '../wager.interface';
import {
  InvalidWagerAmountError,
  InvalidWagerProcessingStateError,
  WagerExternalTransactionConflictError,
  WagerIdempotencyConflictError,
  WagerReservationConflictError,
  WagerWalletMismatchError,
  WagerWalletNotFoundError,
} from '../wager.errors';
import type { ProcessWagerInput } from './process-wager.input';
import type { ProcessWagerResponseDto } from '../dtos/process-wager-response.dto';
import { toWagerResponse, WagerResultWriter } from './wager-result-writer';
import { nextReferenceRetry } from './wager-reference-retry';

@Injectable()
export class ProcessWagerUseCase {
  constructor(
    @Inject(WAGER_REPOSITORY)
    private readonly repository: WagerRepositoryInterface,
    private readonly metrics: MetricsService,
    private readonly resultWriter: WagerResultWriter,
  ) {}

  async execute(input: ProcessWagerInput, ingress?: WagerIngressContext): Promise<ProcessWagerResponseDto> {
    const startedAt = performance.now();
    const result = await this.process(input, ingress);
    this.metrics.recordTransaction(result.status, (performance.now() - startedAt) / 1000, result.idempotentReplay);
    return result;
  }

  private async process(input: ProcessWagerInput, ingress?: WagerIngressContext): Promise<ProcessWagerResponseDto> {
    if (!input.money.isPositive()) throw new InvalidWagerAmountError();

    const payloadHash = createCanonicalWagerHash({
      providerId: input.providerId,
      externalTransactionId: input.externalTransactionId,
      playerId: input.playerId,
      walletId: input.walletId,
      roundId: input.roundId,
      gameId: input.gameId,
      kind: input.kind,
      money: input.money.toJSON(),
      ...(input.referenceExternalTransactionId === undefined
        ? {}
        : { referenceExternalTransactionId: input.referenceExternalTransactionId }),
    });

    let failureContext: { transactionId: string; createdAt: Date; balance: { amount: string; currency: string } } | undefined;
    try {
      return await this.repository.transaction(async (tx) => {
        if (ingress !== undefined) {
          const received = await tx.receiveInbox(ingress.consumerName, ingress.messageId, payloadHash);
          if (!received) {
            const existing = await tx.findByIdempotency(input.providerId, input.idempotencyKey);
            if (existing === undefined) throw new InvalidWagerProcessingStateError();
            return replayOrConflict(existing, payloadHash);
          }
        }

        const existing = await tx.findByIdempotency(input.providerId, input.idempotencyKey);
        if (existing !== undefined) return replayOrConflict(existing, payloadHash);
        if (!(await tx.walletExists(input.walletId))) throw new WagerWalletNotFoundError();

        const now = new Date();
        const transaction = createWagerTransaction(input, payloadHash, uuidv7(), now);
        const wallet = await tx.lockWallet(input.walletId);
        if (wallet === undefined) throw new WagerWalletNotFoundError();
        if (wallet.playerId !== input.playerId || wallet.currency !== input.money.currency) {
          throw new WagerWalletMismatchError();
        }
        await tx.reserve(transaction);
        failureContext = { transactionId: transaction.id, createdAt: now, balance: wallet.balance.toJSON() };

        const referenceExternalTransactionId = transaction.referenceExternalTransactionId;
        if (transaction.awaitsReference() && referenceExternalTransactionId === undefined) {
          throw new InvalidWagerProcessingStateError();
        }
        const reference = referenceExternalTransactionId === undefined
          ? undefined
          : await tx.findReference(input.providerId, referenceExternalTransactionId);
        if (transaction.awaitsReference() && reference === undefined) {
          return this.resultWriter.persistPendingReference(tx, wallet, transaction, nextReferenceRetry(1, now));
        }
        if (reference !== undefined && !transaction.isCompatibleReference(reference)) {
          return this.resultWriter.reject(tx, wallet, transaction, 'WAGER_REFERENCE_MISMATCH');
        }
        if (reference !== undefined && reference.status !== 'PROCESSED') {
          if (!reference.isTerminal()) {
            return this.resultWriter.persistPendingReference(tx, wallet, transaction, nextReferenceRetry(1, now));
          }
          return this.resultWriter.reject(tx, wallet, transaction, 'WAGER_REFERENCE_MISMATCH');
        }

        if (reference !== undefined && !transaction.isValidReferenceFor(reference)) {
          return this.resultWriter.reject(tx, wallet, transaction, 'WAGER_REFERENCE_MISMATCH');
        }
        if (
          reference !== undefined && (transaction.kind === 'REFUND' || transaction.kind === 'ROLLBACK') &&
          await tx.findProcessedReversal(reference.id, transaction.kind)
        ) {
          return this.resultWriter.reject(tx, wallet, transaction, 'WAGER_ALREADY_REVERSED');
        }

        return this.resultWriter.apply(tx, wallet, transaction, reference, now);
      });
    } catch (error: unknown) {
      if (error instanceof WagerReservationConflictError) {
        if (error.conflict === 'EXTERNAL_TRANSACTION') throw new WagerExternalTransactionConflictError();
        const existing = await this.repository.findByIdempotency(input.providerId, input.idempotencyKey);
        if (existing !== undefined) return replayOrConflict(existing, payloadHash);
        throw error;
      }
      if (failureContext === undefined || error instanceof TransientInfrastructureError) throw error;

      const failed = createWagerTransaction(input, payloadHash, failureContext.transactionId, failureContext.createdAt);
      failed.fail('PERMANENT_INFRASTRUCTURE_FAILURE');
      const persisted = await this.repository.persistFailure(failed, failureContext.balance);
      if (!persisted) {
        const existing = await this.repository.findByIdempotency(input.providerId, input.idempotencyKey);
        if (existing !== undefined) return replayOrConflict(existing, payloadHash);
        throw error;
      }
      return toWagerResponse(
        failed.id,
        'FAILED',
        failureContext.balance,
        false,
        'PERMANENT_INFRASTRUCTURE_FAILURE',
      );
    }
  }
}

function createWagerTransaction(
  input: ProcessWagerInput,
  payloadHash: string,
  transactionId: string,
  createdAt: Date,
): WagerTransaction {
  return WagerTransaction.create({
    id: transactionId,
    providerId: input.providerId,
    externalTransactionId: input.externalTransactionId,
    idempotencyKey: input.idempotencyKey,
    payloadHash,
    walletId: input.walletId,
    playerId: input.playerId,
    roundId: input.roundId,
    gameId: input.gameId,
    kind: input.kind,
    money: input.money,
    ...(input.referenceExternalTransactionId === undefined
      ? {}
      : { referenceExternalTransactionId: input.referenceExternalTransactionId }),
    createdAt,
  });
}

function replayOrConflict(existing: StoredWagerResult, payloadHash: string): ProcessWagerResponseDto {
  if (existing.payloadHash !== payloadHash) throw new WagerIdempotencyConflictError();
  return toWagerResponse(
    existing.transactionId,
    existing.status,
    existing.responseBalance,
    true,
    existing.failureCode,
  );
}
