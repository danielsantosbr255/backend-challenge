import type { WalletLedgerEntry } from './domain/wallet-ledger-entry';
import type { Wallet } from './domain/wallet';
import type { WagerTransaction } from '@/modules/wager/domain/wager-transaction';

export const WALLET_REPOSITORY = Symbol('WALLET_REPOSITORY');

export interface OpeningArtifacts {
  transaction: WagerTransaction;
  ledgerEntry: WalletLedgerEntry;
}

export interface WalletRepositoryInterface {
  persistNewWallet(wallet: Wallet, opening?: OpeningArtifacts): Promise<void>;
  findById(walletId: string): Promise<Wallet | undefined>;
  findLedger(walletId: string, cursor: LedgerCursor | undefined, limit: number): Promise<LedgerPage>;
  reconcile(walletId: string): Promise<WalletReconciliation | undefined>;
}

export interface LedgerCursor { createdAt: string; id: string }
export interface LedgerRecord { id: string; transactionId: string; direction: 'CREDIT' | 'DEBIT'; amount: string; currency: string; balanceBefore: string; balanceAfter: string; createdAt: Date }
export interface LedgerPage { entries: LedgerRecord[]; nextCursor?: string }
export interface WalletReconciliation {
  walletId: string;
  storedBalance: { amount: string; currency: string };
  calculatedBalance: { amount: string; currency: string };
  difference: { amount: string; currency: string };
  checkedEntries: number;
}
