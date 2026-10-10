import type { WalletLedgerEntry } from '../domain/wallet-ledger-entry';
import type { Wallet } from '../domain/wallet';
import type { WagerTransaction } from '@/modules/wagering/domain/wager-transaction';

export const WALLET_CREATION_STORE = Symbol('WALLET_CREATION_STORE');

export class WalletAlreadyExistsError extends Error {
  constructor() {
    super('A wallet already exists for this player and currency');
    this.name = 'WalletAlreadyExistsError';
  }
}

export interface OpeningArtifacts {
  transaction: WagerTransaction;
  ledgerEntry: WalletLedgerEntry;
}

export interface WalletCreationStore {
  persistNewWallet(wallet: Wallet, opening?: OpeningArtifacts): Promise<void>;
}
