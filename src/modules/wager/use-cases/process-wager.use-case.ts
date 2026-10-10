import { Inject, Injectable } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';
import { Money } from '@/modules/wallet/domain/money';
import { Wallet } from '@/modules/wallet/domain/wallet';
import { InsufficientFundsError } from '@/modules/wallet/wallet.errors';
import { WalletLedgerEntry } from '@/modules/wallet/domain/wallet-ledger-entry';
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
  WagerReferenceMismatchError,
  WagerReferenceNotFoundError,
  WagerReservationConflictError,
  WagerWalletMismatchError,
  WagerWalletNotFoundError,
} from '../wager.errors';
import type { ProcessWagerInputDto, ProcessWagerResponseDto } from '../dtos/process-wager.dto';

@Injectable()
export class ProcessWagerUseCase {
  constructor(
    @Inject(WAGER_REPOSITORY)
    private readonly repository: WagerRepositoryInterface,
  ) {}

  async execute(input: ProcessWagerInputDto, ingress?: WagerIngressContext): Promise<ProcessWagerResponseDto> {
    if (!input.money.isPositive()) {
      throw new InvalidWagerAmountError();
    }

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
        if (existing !== undefined) {
          return replayOrConflict(existing, payloadHash);
        }

        if (!(await tx.walletExists(input.walletId))) {
          throw new WagerWalletNotFoundError();
        }

        const now = new Date();
        const transaction = WagerTransaction.create({
          id: uuidv7(),
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
          createdAt: now,
        });
        await tx.reserve(transaction);

        const wallet = await tx.lockWallet(input.walletId);
        if (wallet === undefined) {
          throw new WagerWalletNotFoundError();
        }
        if (wallet.playerId !== input.playerId || wallet.currency !== input.money.currency) {
          throw new WagerWalletMismatchError();
        }

        let referenceTransactionId: string | undefined;
        if (input.kind === 'WIN' && input.referenceExternalTransactionId !== undefined) {
          const reference = await tx.findReference(input.providerId, input.referenceExternalTransactionId);
          if (reference === undefined) {
            throw new WagerReferenceNotFoundError();
          }
          if (
            reference.kind !== 'BET' ||
            reference.status !== 'PROCESSED' ||
            reference.providerId !== input.providerId ||
            reference.playerId !== input.playerId ||
            reference.walletId !== input.walletId ||
            reference.roundId !== input.roundId ||
            reference.currency !== input.money.currency
          ) {
            throw new WagerReferenceMismatchError();
          }
          referenceTransactionId = reference.id;
        }

        let ledgerEntry: WalletLedgerEntry | undefined;
        if (input.kind === 'BET') {
          try {
            const change = wallet.debit(input.money, now);
            ledgerEntry = createLedger(transaction, change.balanceBefore, change.balanceAfter, 'DEBIT', now);
            transaction.markProcessed(undefined, now);
          } catch (error: unknown) {
            if (!(error instanceof InsufficientFundsError)) {
              throw error;
            }
            transaction.reject('INSUFFICIENT_FUNDS');
          }
        } else if (input.kind === 'WIN') {
          const change = wallet.credit(input.money, now);
          ledgerEntry = createLedger(transaction, change.balanceBefore, change.balanceAfter, 'CREDIT', now);
          transaction.markProcessed(referenceTransactionId, now);
        } else {
          transaction.markProcessed(undefined, now);
        }

        const balance = wallet.balance.toJSON();
        await tx.persistResult(wallet, transaction, ledgerEntry, balance);
        if (transaction.status !== 'PROCESSED' && transaction.status !== 'REJECTED') {
          throw new InvalidWagerProcessingStateError();
        }
        return toResult(transaction.id, transaction.status, balance, false, transaction.failureCode);
      });
    } catch (error: unknown) {
      if (!(error instanceof WagerReservationConflictError)) {
        throw error;
      }
      if (error.conflict === 'EXTERNAL_TRANSACTION') {
        throw new WagerExternalTransactionConflictError();
      }

      const existing = await this.repository.findByIdempotency(input.providerId, input.idempotencyKey);
      if (existing !== undefined) {
        return replayOrConflict(existing, payloadHash);
      }
      throw error;
    }
  }
}

function createLedger(
  transaction: WagerTransaction,
  balanceBefore: Money,
  balanceAfter: Money,
  direction: 'DEBIT' | 'CREDIT',
  at: Date,
): WalletLedgerEntry {
  return WalletLedgerEntry.create({
    id: uuidv7(),
    walletId: transaction.walletId,
    transactionId: transaction.id,
    direction,
    amount: transaction.money,
    balanceBefore,
    balanceAfter,
    createdAt: at,
  });
}

function replayOrConflict(existing: StoredWagerResult, payloadHash: string): ProcessWagerResponseDto {
  if (existing.payloadHash !== payloadHash) {
    throw new WagerIdempotencyConflictError();
  }
  return toResult(
    existing.transactionId,
    existing.status,
    existing.responseBalance,
    true,
    existing.failureCode,
  );
}

function toResult(
  transactionId: string,
  status: 'PROCESSED' | 'REJECTED',
  balance: { amount: string; currency: string },
  idempotentReplay: boolean,
  failureCode: string | undefined,
): ProcessWagerResponseDto {
  return {
    transactionId,
    status,
    balance,
    idempotentReplay,
    ...(failureCode === undefined ? {} : { failureCode }),
  };
}
