import { Inject, Injectable } from '@nestjs/common';
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
    return this.repository.transaction(async (tx) => {
      const now = new Date();
      const claim = await tx.claimPendingReference(transactionId, now);
      if (claim === undefined) return false;

      const { transaction, attempts } = claim;
      const referenceId = transaction.referenceExternalTransactionId;
      if (referenceId === undefined) throw new InvalidWagerProcessingStateError();
      const reference = await tx.findReference(transaction.providerId, referenceId);
      const waiting = reference === undefined ||
        (transaction.isCompatibleReference(reference) && reference.status !== 'PROCESSED' && !reference.isTerminal());

      if (waiting && attempts < MAX_REFERENCE_ATTEMPTS) {
        await tx.schedulePendingReferenceRetry(transaction.id, nextReferenceRetry(attempts, now));
        this.metrics.recordRetry('reference');
        return true;
      }

      const wallet = await tx.lockWallet(transaction.walletId);
      if (wallet === undefined) throw new WagerWalletNotFoundError();
      if (waiting) {
        await this.resultWriter.reject(tx, wallet, transaction, 'WAGER_REFERENCE_NOT_FOUND');
        return true;
      }
      if (reference === undefined || !transaction.isValidReferenceFor(reference)) {
        await this.resultWriter.reject(tx, wallet, transaction, 'WAGER_REFERENCE_MISMATCH');
        return true;
      }
      if (
        (transaction.kind === 'REFUND' || transaction.kind === 'ROLLBACK') &&
        await tx.findProcessedReversal(reference.id, transaction.kind)
      ) {
        await this.resultWriter.reject(tx, wallet, transaction, 'WAGER_ALREADY_REVERSED');
        return true;
      }
      await this.resultWriter.apply(tx, wallet, transaction, reference, now);
      return true;
    });
  }
}
