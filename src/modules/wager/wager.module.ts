import { Module } from '@nestjs/common';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { OutboxMessageEntity } from './entities/outbox-message.entity';
import { InboxMessageEntity } from './entities/inbox-message.entity';
import { WalletLedgerEntryEntity } from '@/modules/wallet/entities/wallet-ledger-entry.entity';
import { WalletEntity } from '@/modules/wallet/entities/wallet.entity';
import { WagerTransactionEntity } from './entities/wager-transaction.entity';
import { ProcessWagerUseCase } from './use-cases/process-wager.use-case';
import { WAGER_REPOSITORY } from './wager.interface';
import { WagerRepository } from './wager.repository';
import { WagerController } from './wager.controller';
import { MetricsModule } from '@/common/observability/metrics.module';
import { WagerQueryController } from './wager-query.controller';
import { QueryWagerTransactionUseCase } from './use-cases/query-wager-transaction.use-case';
import { ProcessPendingWagerReferencesUseCase } from './use-cases/process-pending-wager-references.use-case';
import { WagerResultWriter } from './use-cases/wager-result-writer';

@Module({
  imports: [
    MetricsModule,
    MikroOrmModule.forFeature([
      WalletEntity,
      WagerTransactionEntity,
      WalletLedgerEntryEntity,
      OutboxMessageEntity,
      InboxMessageEntity,
    ]),
  ],
  controllers: [WagerController, WagerQueryController],
  providers: [
    ProcessWagerUseCase,
    ProcessPendingWagerReferencesUseCase,
    WagerResultWriter,
    QueryWagerTransactionUseCase,
    WagerRepository,
    { provide: WAGER_REPOSITORY, useExisting: WagerRepository },
  ],
  exports: [ProcessWagerUseCase, ProcessPendingWagerReferencesUseCase],
})
export class WagerModule {}
