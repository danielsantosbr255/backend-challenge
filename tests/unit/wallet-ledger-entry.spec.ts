import { describe, expect, it } from 'bun:test';
import { Money } from '@/modules/wallet/domain/money';
import { WalletLedgerEntry, type CreateWalletLedgerEntryProps } from '@/modules/wallet/domain/wallet-ledger-entry';

describe('WalletLedgerEntry', () => {
  it('creates a balanced credit entry', () => {
    const entry = WalletLedgerEntry.create({
      id: '0199c2a0-0000-7000-8000-000000000003',
      walletId: '0199c2a0-0000-7000-8000-000000000001',
      transactionId: '0199c2a0-0000-7000-8000-000000000004',
      direction: 'CREDIT',
      amount: Money.from({ amount: '25.50', currency: 'BRL' }),
      balanceBefore: Money.zero('BRL'),
      balanceAfter: Money.from({ amount: '25.50', currency: 'BRL' }),
      createdAt: new Date('2026-10-09T12:00:00.000Z'),
    });

    expect(entry.isBalanced()).toBe(true);
    expect(entry.balanceAfter.toJSON()).toEqual({ amount: '25.50', currency: 'BRL' });
  });

  it('rejects inconsistent arithmetic, negative balances, zero movements and currency mismatches', () => {
    const base: CreateWalletLedgerEntryProps = {
      id: crypto.randomUUID(), walletId: crypto.randomUUID(), transactionId: crypto.randomUUID(), direction: 'DEBIT',
      amount: Money.from({ amount: '5.00', currency: 'BRL' }),
      balanceBefore: Money.from({ amount: '10.00', currency: 'BRL' }),
      balanceAfter: Money.from({ amount: '5.00', currency: 'BRL' }), createdAt: new Date(),
    };
    expect(WalletLedgerEntry.create(base).isBalanced()).toBe(true);
    expect(() => WalletLedgerEntry.create({ ...base, balanceAfter: Money.zero('BRL') })).toThrow();
    expect(() => WalletLedgerEntry.create({ ...base, amount: Money.zero('BRL') })).toThrow();
    expect(() => WalletLedgerEntry.create({ ...base, balanceAfter: Money.from({ amount: '5.00', currency: 'USD' }) })).toThrow();
    expect(() => WalletLedgerEntry.create({ ...base, balanceAfter: Money.zero('BRL').subtract(base.amount) })).toThrow();
  });
});
