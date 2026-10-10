import { Injectable } from '@nestjs/common';
import { Counter, Gauge, Histogram, Registry } from 'prom-client';

@Injectable()
export class MetricsService {
  readonly registry = new Registry();
  private readonly transactions = new Counter({
    name: 'wager_transactions_total', help: 'Wager transaction results by status', labelNames: ['status'], registers: [this.registry],
  });
  private readonly duplicates = new Counter({
    name: 'wager_idempotent_duplicates_total', help: 'Idempotent duplicate requests detected', registers: [this.registry],
  });
  private readonly retries = new Counter({
    name: 'wager_retries_total', help: 'Retry attempts by processing area', labelNames: ['area'], registers: [this.registry],
  });
  private readonly dlq = new Counter({
    name: 'wager_dlq_messages_total', help: 'Messages moved to the dead-letter queue', registers: [this.registry],
  });
  private readonly dlqDepth = new Gauge({
    name: 'wager_dlq_messages', help: 'Current DLQ depth, including broker redrive', registers: [this.registry],
  });
  private readonly lockConflicts = new Counter({
    name: 'wager_lock_conflicts_total', help: 'Database lock conflicts encountered', registers: [this.registry],
  });
  private readonly reconciliationDivergences = new Counter({
    name: 'wallet_reconciliation_divergences_total', help: 'Wallet reconciliations where stored and ledger balances differ', registers: [this.registry],
  });
  private readonly outboxLag = new Gauge({
    name: 'wager_outbox_lag_seconds', help: 'Age of the oldest unpublished outbox event', registers: [this.registry],
  });
  private readonly processingLatency = new Histogram({
    name: 'wager_processing_duration_seconds', help: 'Wager use case processing latency',
    labelNames: ['status'], buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5], registers: [this.registry],
  });

  recordTransaction(status: string, elapsedSeconds: number, duplicate: boolean): void {
    this.transactions.inc({ status });
    this.processingLatency.observe({ status }, elapsedSeconds);
    if (duplicate) this.duplicates.inc();
  }

  recordRetry(area: 'sqs' | 'outbox' | 'reference'): void { this.retries.inc({ area }); }
  recordDlqMessage(): void { this.dlq.inc(); }
  setDlqDepth(messages: number): void { this.dlqDepth.set(messages); }
  recordLockConflict(): void { this.lockConflicts.inc(); }
  recordReconciliationDivergence(): void { this.reconciliationDivergences.inc(); }
  setOutboxLag(seconds: number): void { this.outboxLag.set(Math.max(0, seconds)); }

  async metrics(): Promise<string> { return this.registry.metrics(); }
  get contentType(): string { return this.registry.contentType; }
}
