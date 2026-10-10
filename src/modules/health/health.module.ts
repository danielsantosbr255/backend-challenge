import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { HealthService } from './health.service';
import { SqsModule } from '@/infrastructure/messaging/sqs.module';
import { MetricsController } from './metrics.controller';
import { MetricsModule } from '@/common/observability/metrics.module';

@Module({
  imports: [SqsModule, MetricsModule],
  controllers: [HealthController, MetricsController],
  providers: [HealthService],
})
export class HealthModule {}
