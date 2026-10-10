import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { HealthModule } from './modules/health/health.module';
import { validateEnv } from './infrastructure/config/env.schema';
import { PersistenceModule } from './infrastructure/persistence/persistence.module';
import { WalletModule } from './modules/wallet/wallet.module';
import { WagerModule } from './modules/wager/wager.module';
import { GlobalHttpExceptionFilter } from './infrastructure/http/global-http-exception.filter';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env', '.env.local'],
      validate: validateEnv,
    }),
    PersistenceModule,
    HealthModule,
    WalletModule,
    WagerModule,
  ],
  providers: [{ provide: APP_FILTER, useClass: GlobalHttpExceptionFilter }],
})
export class AppModule { }
