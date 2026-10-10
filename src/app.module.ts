import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { HealthModule } from './modules/health/health.module';
import { validateEnv } from './infrastructure/config/env.schema';
import { PersistenceModule } from './infrastructure/persistence/persistence.module';
import { WalletModule } from './modules/wallet/wallet.module';

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
  ],
})
export class AppModule { }
