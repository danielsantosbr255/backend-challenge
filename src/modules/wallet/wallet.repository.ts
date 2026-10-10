import { EntityManager, UniqueConstraintViolationException } from '@mikro-orm/core';
import { Inject, Injectable } from '@nestjs/common';
import type { OpeningArtifacts, WalletRepositoryInterface } from './wallet.interface';
import { WalletAlreadyExistsError } from './wallet.errors';
import type { Wallet } from './domain/wallet';
import { WalletLedgerEntryEntity } from './entities/wallet-ledger-entry.entity';
import { WalletEntity } from './entities/wallet.entity';
import { WagerTransactionEntity } from '@/modules/wager/entities/wager-transaction.entity';
import { toLedgerEntryEntityData, toWalletEntityData } from './wallet.mappers';
import { toWagerEntityData } from '@/modules/wager/wager.mappers';

@Injectable()
export class WalletRepository implements WalletRepositoryInterface {
  constructor(@Inject(EntityManager) private readonly em: EntityManager) {}

  async persistNewWallet(wallet: Wallet, opening?: OpeningArtifacts): Promise<void> {
    try {
      await this.em.transactional(async (em) => {
        const walletEntity = em.create(WalletEntity, toWalletEntityData(wallet));
        em.persist(walletEntity);

        if (opening !== undefined) {
          const transactionEntity = em.create(
            WagerTransactionEntity,
            toWagerEntityData(opening.transaction, walletEntity, wallet.balance.toJSON()),
          );
          const ledgerEntryEntity = em.create(
            WalletLedgerEntryEntity,
            toLedgerEntryEntityData(opening.ledgerEntry, walletEntity, transactionEntity),
          );
          em.persist(transactionEntity);
          em.persist(ledgerEntryEntity);
        }

        await em.flush();
      });
    } catch (error: unknown) {
      if (isWalletUniquenessConflict(error)) {
        throw new WalletAlreadyExistsError();
      }
      throw error;
    }
  }
}

function isWalletUniquenessConflict(error: unknown): boolean {
  return (
    error instanceof UniqueConstraintViolationException &&
    'constraint' in error &&
    error.constraint === 'wallets_player_currency_unique'
  );
}
