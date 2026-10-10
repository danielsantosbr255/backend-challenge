import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { delay } from '@/common/async/retry';
import { ProcessPendingWagerReferencesUseCase } from './use-cases/process-pending-wager-references.use-case';

@Injectable()
export class PendingReferenceWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PendingReferenceWorker.name);
  private running = false;
  private loop: Promise<void> | undefined;

  constructor(private readonly processPendingReferences: ProcessPendingWagerReferencesUseCase) {}

  onModuleInit(): void {
    this.running = true;
    this.loop = this.poll();
  }

  async onModuleDestroy(): Promise<void> {
    this.running = false;
    await this.loop;
  }

  private async poll(): Promise<void> {
    while (this.running) {
      try {
        if (await this.processPendingReferences.execute() === 0) await delay(1000);
      } catch (error: unknown) {
        this.logger.error('wager_reference_recovery_retry', {
          event: 'wager_reference_recovery_retry',
          errorType: error instanceof Error ? error.name : 'UnknownError',
        });
        await delay(1000);
      }
    }
  }
}
