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
}
