import type { InferEntity } from '@mikro-orm/core';
import { Wallet, type WalletState } from './domain/wallet';
import type { WalletLedgerEntry } from './domain/wallet-ledger-entry';
import { WalletLedgerEntryEntity } from './entities/wallet-ledger-entry.entity';
import { WalletEntity } from './entities/wallet.entity';
import { WagerTransactionEntity } from '@/modules/wager/entities/wager-transaction.entity';
import { ApplicationError } from '@/common/errors/application.error';
import { InvalidPersistedWalletStateError } from './wallet.errors';

type WalletOrmEntity = InferEntity<typeof WalletEntity>;
type LedgerEntryOrmEntity = InferEntity<typeof WalletLedgerEntryEntity>;
type WagerTransactionOrmEntity = InferEntity<typeof WagerTransactionEntity>;

export function toWalletDomain(entity: WalletOrmEntity): Wallet {
  const state: WalletState = {
    id: entity.id,
    playerId: entity.playerId,
    currency: entity.currency,
    balance: { amount: entity.balance, currency: entity.currency },
    version: entity.version,
    createdAt: entity.createdAt,
    updatedAt: entity.updatedAt,
  };
  try {
    return Wallet.rehydrate(state);
  } catch (error: unknown) {
    if (error instanceof ApplicationError) {
      throw new InvalidPersistedWalletStateError({ cause: error });
    }
    throw error;
  }
}

export function toWalletEntityData(wallet: Wallet) {
  return {
    id: wallet.id,
    playerId: wallet.playerId,
    currency: wallet.currency,
    balance: wallet.balance.toJSON().amount,
    version: wallet.version,
    createdAt: wallet.createdAt,
    updatedAt: wallet.updatedAt,
  };
}

export function toWalletBalanceEntityData(
  wallet: Wallet,
  balance: { amount: string; currency: string },
) {
  return {
    balance: balance.amount,
    version: wallet.version,
    updatedAt: wallet.updatedAt,
  } satisfies Partial<WalletOrmEntity>;
}

export function toLedgerEntryEntityData(
  entry: WalletLedgerEntry,
  wallet: WalletOrmEntity,
  transaction: WagerTransactionOrmEntity,
) {
  return {
    id: entry.id,
    wallet,
    transaction,
    direction: entry.direction,
    amount: entry.amount.toJSON().amount,
    balanceBefore: entry.balanceBefore.toJSON().amount,
    balanceAfter: entry.balanceAfter.toJSON().amount,
    createdAt: entry.createdAt,
  } satisfies Partial<LedgerEntryOrmEntity>;
}
