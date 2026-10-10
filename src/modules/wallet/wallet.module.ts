import { Module } from '@nestjs/common';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { MikroOrmWalletCreationStore } from '@/infrastructure/persistence/mikro-orm-wallet-creation.store';
import { WalletLedgerEntryEntity } from '@/infrastructure/persistence/entities/wallet-ledger-entry.entity';
import { WalletEntity } from '@/infrastructure/persistence/entities/wallet.entity';
import { WagerTransactionEntity } from '@/infrastructure/persistence/entities/wager-transaction.entity';
import { CreateWalletUseCase } from './application/create-wallet.use-case';
import { WALLET_CREATION_STORE } from './application/wallet-creation.store';
import { WalletsController } from './http/wallets.controller';

@Module({
  imports: [MikroOrmModule.forFeature([WalletEntity, WagerTransactionEntity, WalletLedgerEntryEntity])],
  controllers: [WalletsController],
  providers: [
    CreateWalletUseCase,
    MikroOrmWalletCreationStore,
    { provide: WALLET_CREATION_STORE, useExisting: MikroOrmWalletCreationStore },
  ],
})
export class WalletModule {}
