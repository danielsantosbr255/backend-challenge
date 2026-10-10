import { Injectable } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';
import { Money } from '@/modules/wallet/domain/money';
import { Wallet } from '@/modules/wallet/domain/wallet';
import { InsufficientFundsError } from '@/modules/wallet/wallet.errors';
import { WalletLedgerEntry } from '@/modules/wallet/domain/wallet-ledger-entry';
import { WagerTransaction } from '../domain/wager-transaction';
import type { PendingReferenceRetry, WagerUnitOfWork } from '../wager.interface';
import { InvalidWagerProcessingStateError } from '../wager.errors';
import type { ProcessWagerResponseDto } from '../dtos/process-wager-response.dto';

@Injectable()
export class WagerResultWriter {
  async persistPendingReference(
    tx: WagerUnitOfWork,
    wallet: Wallet,
    transaction: WagerTransaction,
    retry: PendingReferenceRetry,
  ): Promise<ProcessWagerResponseDto> {
    transaction.markPendingReference();
    const balance = wallet.balance.toJSON();
    await tx.persistResult(wallet, transaction, undefined, balance, retry);
    return toWagerResponse(transaction.id, 'PENDING_REFERENCE', balance);
  }

  async reject(
    tx: WagerUnitOfWork,
    wallet: Wallet,
    transaction: WagerTransaction,
    failureCode: string,
  ): Promise<ProcessWagerResponseDto> {
    transaction.reject(failureCode);
    const balance = wallet.balance.toJSON();
    await tx.persistResult(wallet, transaction, undefined, balance);
    return toWagerResponse(transaction.id, 'REJECTED', balance, false, failureCode);
  }

  async apply(
    tx: WagerUnitOfWork,
    wallet: Wallet,
    transaction: WagerTransaction,
    reference: WagerTransaction | undefined,
    now: Date,
  ): Promise<ProcessWagerResponseDto> {
    const direction = transaction.ledgerDirectionFor(reference);
    let ledgerEntry: WalletLedgerEntry | undefined;

    if (direction === 'CREDIT') {
      const change = wallet.credit(transaction.money, now);
      ledgerEntry = createLedger(transaction, change.balanceBefore, change.balanceAfter, direction, now);
    } else if (direction === 'DEBIT') {
      try {
        const change = wallet.debit(transaction.money, now);
        ledgerEntry = createLedger(transaction, change.balanceBefore, change.balanceAfter, direction, now);
      } catch (error: unknown) {
        if (!(error instanceof InsufficientFundsError)) throw error;
        transaction.reject(transaction.kind === 'BET' ? 'INSUFFICIENT_FUNDS' : 'REVERSAL_INSUFFICIENT_FUNDS');
      }
    }

    if (!transaction.isTerminal()) transaction.markProcessed(reference?.id, now);
    const balance = wallet.balance.toJSON();
    await tx.persistResult(wallet, transaction, ledgerEntry, balance);
    if (
      transaction.status !== 'PROCESSED' &&
      transaction.status !== 'REJECTED' &&
      transaction.status !== 'PENDING_REFERENCE'
    ) {
      throw new InvalidWagerProcessingStateError();
    }
    return toWagerResponse(transaction.id, transaction.status, balance, false, transaction.failureCode);
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

export function toWagerResponse(
  transactionId: string,
  status: 'PROCESSED' | 'REJECTED' | 'PENDING_REFERENCE' | 'FAILED',
  balance: { amount: string; currency: string },
  idempotentReplay = false,
  failureCode?: string,
): ProcessWagerResponseDto {
  return {
    transactionId,
    status,
    balance,
    idempotentReplay,
    ...(failureCode === undefined ? {} : { failureCode }),
  };
}
