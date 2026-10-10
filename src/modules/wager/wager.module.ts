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

@Module({
  imports: [
    MikroOrmModule.forFeature([
      WalletEntity,
      WagerTransactionEntity,
      WalletLedgerEntryEntity,
      OutboxMessageEntity,
      InboxMessageEntity,
    ]),
  ],
  controllers: [WagerController],
  providers: [
    ProcessWagerUseCase,
    WagerRepository,
    { provide: WAGER_REPOSITORY, useExisting: WagerRepository },
  ],
  exports: [ProcessWagerUseCase],
})
export class WagerModule {}
