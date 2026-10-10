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
  status: 'PROCESSED' | 'REJECTED';
  failureCode: string | undefined;
  responseBalance: { amount: string; currency: string };
}

export interface WagerReference {
  id: string;
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  kind: string;
  status: string;
  currency: string;
}

export interface WagerUnitOfWork {
  findByIdempotency(providerId: string, idempotencyKey: string): Promise<StoredWagerResult | undefined>;
  walletExists(walletId: string): Promise<boolean>;
  reserve(transaction: WagerTransaction): Promise<void>;
  lockWallet(walletId: string): Promise<Wallet | undefined>;
  findReference(providerId: string, externalTransactionId: string): Promise<WagerReference | undefined>;
  persistResult(
    wallet: Wallet,
    transaction: WagerTransaction,
    ledgerEntry: WalletLedgerEntry | undefined,
    balance: { amount: string; currency: string },
  ): Promise<void>;
}

export interface WagerRepositoryInterface {
  transaction<T>(work: (tx: WagerUnitOfWork) => Promise<T>): Promise<T>;
  findByIdempotency(providerId: string, idempotencyKey: string): Promise<StoredWagerResult | undefined>;
}
