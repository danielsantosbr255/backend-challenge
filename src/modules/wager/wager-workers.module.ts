import { Module } from '@nestjs/common';
import { SqsModule } from '@/infrastructure/messaging/sqs.module';
import { WagerModule } from './wager.module';
import { OutboxPublisher } from './outbox-publisher';
import { WagerSqsConsumer } from './wager-sqs-consumer';

@Module({
  imports: [WagerModule, SqsModule],
  providers: [WagerSqsConsumer, OutboxPublisher],
})
export class WagerWorkersModule {}
