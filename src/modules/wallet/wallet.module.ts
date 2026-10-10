import { Module } from '@nestjs/common';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { WalletLedgerEntryEntity } from './entities/wallet-ledger-entry.entity';
import { WalletEntity } from './entities/wallet.entity';
import { WagerTransactionEntity } from '@/modules/wager/entities/wager-transaction.entity';
import { CreateWalletUseCase } from './use-cases/create-wallet.use-case';
import { WALLET_REPOSITORY } from './wallet.interface';
import { WalletRepository } from './wallet.repository';
import { WalletController } from './wallet.controller';
import { QueryWalletUseCase } from './use-cases/query-wallet.use-case';
import { MetricsModule } from '@/common/observability/metrics.module';

@Module({
  imports: [MetricsModule, MikroOrmModule.forFeature([WalletEntity, WagerTransactionEntity, WalletLedgerEntryEntity])],
  controllers: [WalletController],
  providers: [
    CreateWalletUseCase,
    QueryWalletUseCase,
    WalletRepository,
    { provide: WALLET_REPOSITORY, useExisting: WalletRepository },
  ],
})
export class WalletModule {}
