import 'reflect-metadata';
import { SQSClient } from '@aws-sdk/client-sqs';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { validateEnv } from '@/infrastructure/config/env.schema';
import { PersistenceModule } from '@/infrastructure/persistence/persistence.module';
import { SQS_CLIENT } from '@/infrastructure/messaging/sqs-client.provider';
import { WagerWorkersModule } from '@/modules/wager/wager-workers.module';

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true, validate: validateEnv }),
    PersistenceModule, WagerWorkersModule],
})
class CrashWorkerModule {}

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(CrashWorkerModule, { logger: false });
  const sqs = app.get<SQSClient>(SQS_CLIENT);
  // Fault injection at the real SDK transport: business logic, database and broker remain real.
  sqs.middlewareStack.add((next, context) => async (args) => {
    if (context.commandName === 'ReceiveMessageCommand' && typeof args.input === 'object' && args.input !== null) {
      Reflect.set(args.input, 'VisibilityTimeout', 2);
      Reflect.set(args.input, 'WaitTimeSeconds', 1);
    }
    if (context.commandName === 'DeleteMessageCommand' && process.env['BLOCK_ACK'] === 'true') {
      console.log('COMMITTED_BEFORE_ACK');
      await new Promise<void>(() => {});
    }
    if (context.commandName === 'SendMessageCommand' && typeof args.input === 'object' && args.input !== null
      && 'MessageGroupId' in args.input && args.input.MessageGroupId === process.env['BLOCK_PUBLISH_WALLET_ID']) {
      console.log('CLAIMED_BEFORE_PUBLISH');
      await new Promise<void>(() => {});
    }
    return next(args);
  }, { step: 'initialize', name: 'crashTestBoundary' });
  await app.init();
  console.log('WORKER_READY');
}

void bootstrap();
