import { Module } from '@nestjs/common';
import { SQS_CLIENT, SqsClientProvider } from './sqs-client.provider';

@Module({
  providers: [SqsClientProvider],
  exports: [SQS_CLIENT],
})
export class SqsModule {}
