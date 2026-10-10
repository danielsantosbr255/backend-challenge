import { Inject, Injectable, Logger } from '@nestjs/common';
import { MetricsService } from '@/common/observability/metrics.service';
import { WALLET_REPOSITORY, type WalletRepositoryInterface } from '../wallet.interface';
import { WalletNotFoundError } from '../wallet.errors';
import type { WalletLedgerResponseDto, WalletReconciliationResponseDto, WalletResponseDto } from '../dtos/wallet-query-response.dto';

@Injectable()
export class QueryWalletUseCase {
  private readonly logger = new Logger(QueryWalletUseCase.name);

  constructor(
    @Inject(WALLET_REPOSITORY) private readonly repository: WalletRepositoryInterface,
    private readonly metrics: MetricsService,
  ) {}

  async get(walletId: string): Promise<WalletResponseDto> {
    const wallet = await this.repository.findById(walletId);
    if (wallet === undefined) throw new WalletNotFoundError();
    return { id: wallet.id, playerId: wallet.playerId, balance: wallet.balance.toJSON(), version: wallet.version };
  }

  async getLedger(walletId: string, cursor: { createdAt: string; id: string } | undefined, limit: number): Promise<WalletLedgerResponseDto> {
    if (!(await this.repository.findById(walletId))) throw new WalletNotFoundError();
    const page = await this.repository.findLedger(walletId, cursor, limit);
    return {
      entries: page.entries.map((entry) => ({
        id: entry.id,
        transactionId: entry.transactionId,
        direction: entry.direction,
        money: { amount: entry.amount, currency: entry.currency },
        balanceBefore: { amount: entry.balanceBefore, currency: entry.currency },
        balanceAfter: { amount: entry.balanceAfter, currency: entry.currency },
        createdAt: entry.createdAt.toISOString(),
      })),
      ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
    };
  }

  async reconcile(walletId: string): Promise<WalletReconciliationResponseDto> {
    const result = await this.repository.reconcile(walletId);
    if (result === undefined) throw new WalletNotFoundError();
    const consistent = result.difference.amount === '0.00';
    if (!consistent) {
      this.metrics.recordReconciliationDivergence();
      this.logger.error(JSON.stringify({ event: 'wallet_reconciliation_divergence', walletId }));
    }
    return { ...result, consistent };
  }
}
