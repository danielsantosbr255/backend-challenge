import { Inject, Injectable, Logger } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';
import { Money } from '../domain/money';
import { Wallet } from '../domain/wallet';
import { WalletLedgerEntry } from '../domain/wallet-ledger-entry';
import { WagerTransaction } from '@/modules/wager/domain/wager-transaction';
import { WALLET_REPOSITORY, type WalletRepositoryInterface } from '../wallet.interface';

export interface CreateWalletInput {
  playerId: string;
  initialBalance: Money;
}

@Injectable()
export class CreateWalletUseCase {
  private readonly logger = new Logger(CreateWalletUseCase.name);
  constructor(
    @Inject(WALLET_REPOSITORY)
    private readonly walletRepository: WalletRepositoryInterface,
  ) {}

  async execute(input: CreateWalletInput): Promise<Wallet> {
    const openedAt = new Date();
    const wallet = Wallet.open({
      id: uuidv7(),
      playerId: input.playerId,
      initialBalance: input.initialBalance,
      openedAt,
    });
    const logContext = { correlationId: wallet.id, messageId: 'http', walletId: wallet.id, providerId: 'internal' };

    if (!wallet.balance.isPositive()) {
      await this.walletRepository.persistNewWallet(wallet);
      this.logger.log('wallet_opened', { ...logContext, transactionId: 'none' });
      return wallet;
    }

    const openingTransaction = WagerTransaction.opening({
      id: uuidv7(),
      walletId: wallet.id,
      playerId: wallet.playerId,
      money: wallet.balance,
      createdAt: openedAt,
    });
    const openingLedgerEntry = WalletLedgerEntry.create({
      id: uuidv7(),
      walletId: wallet.id,
      transactionId: openingTransaction.id,
      direction: 'CREDIT',
      amount: wallet.balance,
      balanceBefore: Money.zero(wallet.currency),
      balanceAfter: wallet.balance,
      createdAt: openedAt,
    });

    await this.walletRepository.persistNewWallet(wallet, {
      transaction: openingTransaction,
      ledgerEntry: openingLedgerEntry,
    });
    this.logger.log('wallet_opened', { ...logContext, transactionId: openingTransaction.id });
    return wallet;
  }
}
