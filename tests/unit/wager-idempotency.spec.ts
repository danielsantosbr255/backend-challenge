import { describe, expect, it } from 'bun:test';
import { MetricsService } from '@/common/observability/metrics.service';
import { Money } from '@/modules/wallet/domain/money';
import { ProcessWagerUseCase } from '@/modules/wager/use-cases/process-wager.use-case';
import { WagerResultWriter } from '@/modules/wager/use-cases/wager-result-writer';
import type { ProcessWagerInput } from '@/modules/wager/use-cases/process-wager.input';
import type { WagerRepositoryInterface, StoredWagerResult } from '@/modules/wager/wager.interface';
import { WagerIdempotencyConflictError, WagerReservationConflictError } from '@/modules/wager/wager.errors';
import { createCanonicalWagerHash } from '@/modules/wager/wager.utils';

describe('Idempotency after a persistence reservation conflict', () => {
  const input: ProcessWagerInput = {
    providerId: 'provider-a', externalTransactionId: 'bet-1', idempotencyKey: 'key-1',
    playerId: crypto.randomUUID(), walletId: crypto.randomUUID(), roundId: 'round-1', gameId: 'game-1', kind: 'BET',
    money: Money.from({ amount: '10.00', currency: 'BRL' }),
  };
  const stored: StoredWagerResult = {
    transactionId: crypto.randomUUID(), providerId: input.providerId, externalTransactionId: input.externalTransactionId,
    idempotencyKey: input.idempotencyKey, payloadHash: createCanonicalWagerHash({ ...input, money: input.money.toJSON() }),
    status: 'PROCESSED', failureCode: undefined, responseBalance: { amount: '90.00', currency: 'BRL' },
  };
  // Simulate only the persistence boundary, not concurrency or financial rules.
  const repository: WagerRepositoryInterface = {
    transaction: async () => { throw new WagerReservationConflictError('IDEMPOTENCY'); },
    findByIdempotency: async () => stored,
    findDuePendingReferenceIds: async () => [],
    findTransaction: async () => undefined,
    findProviderTransaction: async () => undefined,
    persistFailure: async () => false,
  };
  const useCase = new ProcessWagerUseCase(repository, new MetricsService(), new WagerResultWriter());

  it('returns the committed original balance for an identical payload', async () => {
    expect(await useCase.execute(input)).toMatchObject({ transactionId: stored.transactionId,
      balance: { amount: '90.00', currency: 'BRL' }, idempotentReplay: true });
  });

  it('rejects the same key with a divergent business payload', async () => {
    await expect(useCase.execute({ ...input, money: Money.from({ amount: '11.00', currency: 'BRL' }) }))
      .rejects.toBeInstanceOf(WagerIdempotencyConflictError);
  });
});
