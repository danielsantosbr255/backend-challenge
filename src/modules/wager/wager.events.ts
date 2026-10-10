import { v7 as uuidv7 } from 'uuid';
import type { Wallet } from '@/modules/wallet/domain/wallet';
import type { WalletLedgerEntry } from '@/modules/wallet/domain/wallet-ledger-entry';
import type { WagerTransaction } from './domain/wager-transaction';
import { InvalidWagerProcessingStateError } from './wager.errors';
import {
  IntegrationEvent,
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
} from './domain/integration-event';

export function createWagerEvents(
  transaction: WagerTransaction,
  wallet: Wallet,
  ledgerEntry: WalletLedgerEntry | undefined,
  balance: { amount: string; currency: string },
): IntegrationEvent<Record<string, unknown>>[] {
  const context = {
    eventId: uuidv7(),
    aggregateId: wallet.id,
    correlationId: transaction.externalTransactionId,
    causationId: transaction.id,
    occurredAt: transaction.processedAt ?? transaction.createdAt,
  };
  const commonData = {
    transactionId: transaction.id,
    providerId: transaction.providerId,
    externalTransactionId: transaction.externalTransactionId,
    balance,
  };
  let event: IntegrationEvent<Record<string, unknown>>;
  switch (transaction.status) {
    case 'PROCESSED':
      event = new WagerTransactionProcessed({ ...context, data: { ...commonData, status: 'PROCESSED' } });
      break;
    case 'REJECTED':
      if (transaction.failureCode === undefined) throw new InvalidWagerProcessingStateError();
      event = new WagerTransactionRejected({
        ...context,
        data: { ...commonData, status: 'REJECTED', failureCode: transaction.failureCode },
      });
      break;
    case 'PENDING_REFERENCE':
      if (transaction.referenceExternalTransactionId === undefined) throw new InvalidWagerProcessingStateError();
      event = new WagerTransactionPendingReference({
        ...context,
        data: {
          ...commonData,
          status: 'PENDING_REFERENCE',
          referenceExternalTransactionId: transaction.referenceExternalTransactionId,
        },
      });
      break;
    default:
      throw new InvalidWagerProcessingStateError();
  }
  const events: IntegrationEvent<Record<string, unknown>>[] = [event];

  if (ledgerEntry !== undefined) {
    events.push(new WalletBalanceChanged({
      ...context,
      eventId: uuidv7(),
      data: {
        walletId: wallet.id,
        transactionId: transaction.id,
        direction: ledgerEntry.direction,
        money: ledgerEntry.amount.toJSON(),
        balanceBefore: ledgerEntry.balanceBefore.toJSON(),
        balanceAfter: ledgerEntry.balanceAfter.toJSON(),
        walletVersion: wallet.version,
      },
    }));
  }

  return events;
}
