import { EntityManager, UniqueConstraintViolationException } from '@mikro-orm/core';
import { Inject, Injectable } from '@nestjs/common';
import type {
  OpeningArtifacts,
  WalletCreationStore,
} from '@/modules/wallet/application/wallet-creation.store';
import { WalletAlreadyExistsError } from '@/modules/wallet/application/wallet-creation.store';
import type { Wallet } from '@/modules/wallet/domain/wallet';
import { WalletLedgerEntryEntity } from './entities/wallet-ledger-entry.entity';
import { WalletEntity } from './entities/wallet.entity';
import { WagerTransactionEntity } from './entities/wager-transaction.entity';

@Injectable()
export class MikroOrmWalletCreationStore implements WalletCreationStore {
  constructor(@Inject(EntityManager) private readonly em: EntityManager) {}

  async persistNewWallet(wallet: Wallet, opening?: OpeningArtifacts): Promise<void> {
    try {
      await this.em.transactional(async (em) => {
        const walletEntity = em.create(WalletEntity, {
          id: wallet.id,
          playerId: wallet.playerId,
          currency: wallet.currency,
          balance: wallet.balance.toJSON().amount,
          version: wallet.version,
          createdAt: wallet.createdAt,
          updatedAt: wallet.updatedAt,
        });
        em.persist(walletEntity);

        if (opening !== undefined) {
          const transactionEntity = em.create(WagerTransactionEntity, {
            id: opening.transaction.id,
            providerId: opening.transaction.providerId,
            externalTransactionId: opening.transaction.externalTransactionId,
            idempotencyKey: opening.transaction.idempotencyKey,
            payloadHash: opening.transaction.payloadHash,
            wallet: walletEntity,
            playerId: opening.transaction.playerId,
            roundId: opening.transaction.roundId,
            gameId: opening.transaction.gameId,
            kind: opening.transaction.kind,
            amount: opening.transaction.money.toJSON().amount,
            currency: opening.transaction.money.currency,
            referenceExternalTransactionId: null,
            referenceTransaction: null,
            status: opening.transaction.status,
            failureCode: null,
            processedAt: opening.transaction.processedAt,
            responseBalanceAmount: wallet.balance.toJSON().amount,
            responseBalanceCurrency: wallet.currency,
            createdAt: opening.transaction.createdAt,
          });
          const ledgerEntryEntity = em.create(WalletLedgerEntryEntity, {
            id: opening.ledgerEntry.id,
            wallet: walletEntity,
            transaction: transactionEntity,
            direction: opening.ledgerEntry.direction,
            amount: opening.ledgerEntry.amount.toJSON().amount,
            balanceBefore: opening.ledgerEntry.balanceBefore.toJSON().amount,
            balanceAfter: opening.ledgerEntry.balanceAfter.toJSON().amount,
            createdAt: opening.ledgerEntry.createdAt,
          });
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
