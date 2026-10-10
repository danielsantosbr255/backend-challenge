import { describe, expect, it } from 'bun:test';
import { toWalletDomain } from '@/modules/wallet/wallet.mappers';
import { InvalidPersistedWalletStateError } from '@/modules/wallet/wallet.errors';

describe('wallet persistence mappers', () => {
  it('classifies invalid persisted wallet state as an internal consistency error', () => {
    const entity = {
      id: '0192f291-27dd-7d3f-8071-5f8685deef37',
      playerId: '0192f291-27dd-7d3f-8071-5f8685deef38',
      currency: 'BRL',
      balance: '-1.00',
      version: 1,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    } satisfies Parameters<typeof toWalletDomain>[0];

    expect(() => toWalletDomain(entity)).toThrow(InvalidPersistedWalletStateError);
  });
});
