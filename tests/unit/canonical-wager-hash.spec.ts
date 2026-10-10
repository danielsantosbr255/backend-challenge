import { describe, expect, it } from 'bun:test';
import { createCanonicalWagerHash } from '@/modules/wager/wager.utils';

describe('createCanonicalWagerHash', () => {
  it('hashes business fields in canonical key order and ignores transport metadata', () => {
    const first = createCanonicalWagerHash({
      providerId: 'provider-a',
      externalTransactionId: 'external-1',
      playerId: 'player-1',
      walletId: 'wallet-1',
      roundId: 'round-1',
      gameId: 'game-1',
      kind: 'BET',
      money: { amount: '5.00', currency: 'BRL' },
    });
    const second = createCanonicalWagerHash({
      money: { currency: 'BRL', amount: '5.00' },
      kind: 'BET',
      gameId: 'game-1',
      roundId: 'round-1',
      walletId: 'wallet-1',
      playerId: 'player-1',
      externalTransactionId: 'external-1',
      providerId: 'provider-a',
    });

    expect(first).toBe(second);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
  });

  it('includes a business reference when present', () => {
    const base = {
      providerId: 'provider-a',
      externalTransactionId: 'external-1',
      playerId: 'player-1',
      walletId: 'wallet-1',
      roundId: 'round-1',
      gameId: 'game-1',
      kind: 'WIN' as const,
      money: { amount: '5.00', currency: 'BRL' },
    };

    expect(createCanonicalWagerHash(base)).not.toBe(
      createCanonicalWagerHash({ ...base, referenceExternalTransactionId: 'bet-1' }),
    );
  });
});
