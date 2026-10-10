import { describe, expect, it } from 'bun:test';
import 'reflect-metadata';
import { parseWagerMessage } from '@/infrastructure/messaging/wager-message';

describe('parseWagerMessage', () => {
  const valid = {
    messageId: 'message-1',
    type: 'WagerTransactionRequested',
    occurredAt: '2026-10-10T00:00:00.000Z',
    data: {
      providerId: 'provider-a',
      externalTransactionId: 'transaction-1',
      idempotencyKey: 'provider-a:transaction-1',
      playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1',
      walletId: '0192f291-27dd-7d3f-8071-5f8685deef37',
      roundId: 'round-1',
      gameId: 'game-1',
      kind: 'BET',
      money: { amount: '25.00', currency: 'BRL' },
    },
  };

  it('validates and maps a queue envelope to the shared use case input', () => {
    const parsed = parseWagerMessage(JSON.stringify(valid));
    if (parsed === undefined) throw new Error('Valid wager message was rejected');
    expect(parsed.messageId).toBe('message-1');
    expect(parsed.data.idempotencyKey).toBe('provider-a:transaction-1');
    expect(parsed.data.money.toJSON()).toEqual({ amount: '25.00', currency: 'BRL' });
  });

  it('rejects malformed envelopes and unsupported kinds', () => {
    expect(parseWagerMessage('{')).toBeUndefined();
    expect(parseWagerMessage(JSON.stringify({ ...valid, type: 'Other' }))).toBeUndefined();
    expect(parseWagerMessage(JSON.stringify({ ...valid, data: { ...valid.data, kind: 'OPENING' } })))
      .toBeUndefined();
    expect(parseWagerMessage(JSON.stringify({
      ...valid,
      data: { ...valid.data, money: { amount: '0.00', currency: 'BRL' } },
    }))).toBeUndefined();
  });

  it('accepts reversal kinds only with their required external reference', () => {
    expect(parseWagerMessage(JSON.stringify({
      ...valid,
      data: { ...valid.data, kind: 'REFUND', referenceExternalTransactionId: 'bet-1' },
    }))).toBeDefined();
    expect(parseWagerMessage(JSON.stringify({
      ...valid,
      data: { ...valid.data, kind: 'ROLLBACK' },
    }))).toBeUndefined();
  });
});
