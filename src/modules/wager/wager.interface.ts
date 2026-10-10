import type { WalletLedgerEntry } from '@/modules/wallet/domain/wallet-ledger-entry';
import type { Wallet } from '@/modules/wallet/domain/wallet';
import type { WagerTransaction } from './domain/wager-transaction';

export const WAGER_REPOSITORY = Symbol('WAGER_REPOSITORY');

export interface StoredWagerResult {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  status: 'PROCESSED' | 'REJECTED' | 'PENDING_REFERENCE' | 'FAILED';
  failureCode: string | undefined;
  responseBalance: { amount: string; currency: string };
}

export interface PendingReferenceClaim {
  transaction: WagerTransaction;
  attempts: number;
}

export interface PendingReferenceRetry {
  attempts: number;
  nextAttemptAt: Date;
}

export interface WagerTransactionQuery {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  kind: string;
  status: string;
  money: { amount: string; currency: string };
  referenceExternalTransactionId?: string;
  failureCode?: string;
  responseBalance?: { amount: string; currency: string };
  createdAt: Date;
  processedAt?: Date;
}

export interface WagerUnitOfWork {
  receiveInbox(consumerName: string, messageId: string, payloadHash: string): Promise<boolean>;
  findByIdempotency(providerId: string, idempotencyKey: string): Promise<StoredWagerResult | undefined>;
  walletExists(walletId: string): Promise<boolean>;
  reserve(transaction: WagerTransaction): Promise<void>;
  lockWallet(walletId: string): Promise<Wallet | undefined>;
  findReference(providerId: string, externalTransactionId: string): Promise<WagerTransaction | undefined>;
  findProcessedReversal(referenceTransactionId: string, kind: 'REFUND' | 'ROLLBACK'): Promise<boolean>;
  claimPendingReference(transactionId: string, now: Date): Promise<PendingReferenceClaim | undefined>;
  schedulePendingReferenceRetry(transactionId: string, retry: PendingReferenceRetry): Promise<void>;
  persistResult(
    wallet: Wallet,
    transaction: WagerTransaction,
    ledgerEntry: WalletLedgerEntry | undefined,
    balance: { amount: string; currency: string },
    pendingReferenceRetry?: PendingReferenceRetry,
  ): Promise<void>;
}

export interface WagerIngressContext {
  consumerName: string;
  messageId: string;
}

export interface WagerRepositoryInterface {
  transaction<T>(work: (tx: WagerUnitOfWork) => Promise<T>): Promise<T>;
  findByIdempotency(providerId: string, idempotencyKey: string): Promise<StoredWagerResult | undefined>;
  findDuePendingReferenceIds(now: Date, limit: number): Promise<string[]>;
  findTransaction(transactionId: string): Promise<WagerTransactionQuery | undefined>;
  findProviderTransaction(providerId: string, externalTransactionId: string): Promise<WagerTransactionQuery | undefined>;
  persistFailure(transaction: WagerTransaction, balance: { amount: string; currency: string }): Promise<boolean>;
}
