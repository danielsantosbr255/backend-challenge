import { describe, expect, it } from 'bun:test';
import { Money } from '@/modules/wallet/domain/money';
import { Wallet } from '@/modules/wallet/domain/wallet';
import { CurrencyMismatchError, InsufficientFundsError } from '@/modules/wallet/wallet.errors';

describe('Wallet', () => {
  it('opens with the initial balance and version one', () => {
    const openedAt = new Date('2026-10-09T12:00:00.000Z');
    const wallet = Wallet.open({
      id: '0199c2a0-0000-7000-8000-000000000001',
      playerId: '0199c2a0-0000-7000-8000-000000000002',
      initialBalance: Money.from({ amount: '25.50', currency: 'BRL' }),
      openedAt,
    });

    expect(wallet.balance.toJSON()).toEqual({ amount: '25.50', currency: 'BRL' });
    expect(wallet.currency).toBe('BRL');
    expect(wallet.version).toBe(1);
    expect(wallet.createdAt).toEqual(openedAt);
    expect(wallet.updatedAt).toEqual(openedAt);
  });

  it('rehydrates persisted state without resetting the version', () => {
    const createdAt = new Date('2026-10-08T12:00:00.000Z');
    const updatedAt = new Date('2026-10-09T12:00:00.000Z');
    const wallet = Wallet.rehydrate({
      id: '0199c2a0-0000-7000-8000-000000000001',
      playerId: '0199c2a0-0000-7000-8000-000000000002',
      currency: 'BRL',
      balance: { amount: '25.50', currency: 'BRL' },
      version: 7,
      createdAt,
      updatedAt,
    });

    expect(wallet.balance.toJSON()).toEqual({ amount: '25.50', currency: 'BRL' });
    expect(wallet.version).toBe(7);
    expect(wallet.createdAt).toEqual(createdAt);
    expect(wallet.updatedAt).toEqual(updatedAt);
  });

  it('increments version only when a credit or debit changes the balance', () => {
    const openedAt = new Date('2026-10-09T12:00:00.000Z');
    const updatedAt = new Date('2026-10-09T12:01:00.000Z');
    const wallet = Wallet.open({
      id: '0199c2a0-0000-7000-8000-000000000001',
      playerId: '0199c2a0-0000-7000-8000-000000000002',
      initialBalance: Money.from({ amount: '10.00', currency: 'BRL' }),
      openedAt,
    });

    const unchanged = wallet.credit(Money.zero('BRL'), updatedAt);
    expect(unchanged.changed).toBe(false);
    expect(wallet.version).toBe(1);
    expect(wallet.updatedAt).toEqual(openedAt);

    const credited = wallet.credit(Money.from({ amount: '2.00', currency: 'BRL' }), updatedAt);
    expect(credited.balanceBefore.toJSON()).toEqual({ amount: '10.00', currency: 'BRL' });
    expect(credited.balanceAfter.toJSON()).toEqual({ amount: '12.00', currency: 'BRL' });
    expect(wallet.version).toBe(2);
    expect(wallet.updatedAt).toEqual(updatedAt);

    wallet.debit(Money.from({ amount: '2.00', currency: 'BRL' }), new Date('2026-10-09T12:02:00.000Z'));
    expect(wallet.version).toBe(3);
    expect(wallet.balance.toJSON()).toEqual({ amount: '10.00', currency: 'BRL' });
  });

  it('rejects overdrafts and cross-currency movements without changing state', () => {
    const wallet = Wallet.open({
      id: '0199c2a0-0000-7000-8000-000000000001',
      playerId: '0199c2a0-0000-7000-8000-000000000002',
      initialBalance: Money.from({ amount: '10.00', currency: 'BRL' }),
    });

    expect(() => wallet.debit(Money.from({ amount: '10.01', currency: 'BRL' }), new Date())).toThrow(
      InsufficientFundsError,
    );
    expect(() => wallet.credit(Money.from({ amount: '1.00', currency: 'USD' }), new Date())).toThrow(
      CurrencyMismatchError,
    );
    expect(wallet.balance.toJSON()).toEqual({ amount: '10.00', currency: 'BRL' });
    expect(wallet.version).toBe(1);
  });
});
