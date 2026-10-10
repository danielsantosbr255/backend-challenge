import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ProcessWagerResponseDto } from '../dtos/process-wager-response.dto';
import { MetricsService } from '@/common/observability/metrics.service';
import {
  WAGER_REPOSITORY,
  type WagerRepositoryInterface,
} from '../wager.interface';
import { InvalidWagerProcessingStateError, WagerWalletNotFoundError } from '../wager.errors';
import { WagerResultWriter } from './wager-result-writer';
import { nextReferenceRetry } from './wager-reference-retry';

const MAX_REFERENCE_ATTEMPTS = 5;
const MAX_PENDING_REFERENCE_BATCH = 25;

@Injectable()
export class ProcessPendingWagerReferencesUseCase {
  private readonly logger = new Logger(ProcessPendingWagerReferencesUseCase.name);
  constructor(
    @Inject(WAGER_REPOSITORY) private readonly repository: WagerRepositoryInterface,
    private readonly resultWriter: WagerResultWriter,
    private readonly metrics: MetricsService,
  ) {}

  async execute(): Promise<number> {
    const ids = await this.repository.findDuePendingReferenceIds(new Date(), MAX_PENDING_REFERENCE_BATCH);
    let processed = 0;
    for (const id of ids) {
      if (await this.processReference(id)) processed += 1;
    }
    return processed;
  }

  private async processReference(transactionId: string): Promise<boolean> {
    const startedAt = performance.now();
    let context = { correlationId: 'unknown', messageId: 'reference-worker', transactionId, walletId: 'unknown', providerId: 'unknown' };
    const result = await this.repository.transaction<ProcessWagerResponseDto | 'RETRY' | undefined>(async (tx) => {
      const now = new Date();
      const claim = await tx.claimPendingReference(transactionId, now);
      if (claim === undefined) return undefined;

      const { transaction, attempts } = claim;
      context = { ...context, correlationId: transaction.externalTransactionId,
        walletId: transaction.walletId, providerId: transaction.providerId };
      const referenceId = transaction.referenceExternalTransactionId;
      if (referenceId === undefined) throw new InvalidWagerProcessingStateError();
      const reference = await tx.findReference(transaction.providerId, referenceId);
      const waiting = reference === undefined ||
        (transaction.isCompatibleReference(reference) && reference.status !== 'PROCESSED' && !reference.isTerminal());

      if (waiting && attempts < MAX_REFERENCE_ATTEMPTS) {
        await tx.schedulePendingReferenceRetry(transaction.id, nextReferenceRetry(attempts, now));
        return 'RETRY';
      }

      const wallet = await tx.lockWallet(transaction.walletId);
      if (wallet === undefined) throw new WagerWalletNotFoundError();
      if (waiting) {
        return this.resultWriter.reject(tx, wallet, transaction, 'WAGER_REFERENCE_NOT_FOUND');
      }
      if (reference === undefined || !transaction.isValidReferenceFor(reference)) {
        return this.resultWriter.reject(tx, wallet, transaction, 'WAGER_REFERENCE_MISMATCH');
      }
      if (
        (transaction.kind === 'REFUND' || transaction.kind === 'ROLLBACK') &&
        await tx.findProcessedReversal(reference.id, transaction.kind)
      ) {
        return this.resultWriter.reject(tx, wallet, transaction, 'WAGER_ALREADY_REVERSED');
      }
      return this.resultWriter.apply(tx, wallet, transaction, reference, now);
    });
    if (result === undefined) return false;
    if (result === 'RETRY') this.metrics.recordRetry('reference');
    else {
      this.metrics.recordTransaction(result.status, (performance.now() - startedAt) / 1000, false);
      this.logger.log('wager_reference_resolved', { ...context, status: result.status });
    }
    return true;
  }
}
