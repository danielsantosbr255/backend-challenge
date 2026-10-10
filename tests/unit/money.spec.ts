import { describe, expect, it } from 'bun:test';
import { Money } from '@/modules/wallet/domain/money';
import { CurrencyMismatchError, InvalidMoneyError } from '@/modules/wallet/wallet.errors';

describe('Money', () => {
  it('adds decimal amounts exactly and serializes with two decimal places', () => {
    const result = Money.from({ amount: '0.10', currency: 'BRL' }).add(
      Money.from({ amount: '0.20', currency: 'BRL' }),
    );

    expect(result.toJSON()).toEqual({ amount: '0.30', currency: 'BRL' });
  });

  it('normalizes whole amounts and zero to fixed-scale strings', () => {
    expect(Money.from({ amount: '25', currency: 'BRL' }).toJSON()).toEqual({
      amount: '25.00',
      currency: 'BRL',
    });
    expect(Money.zero('BRL').toJSON()).toEqual({ amount: '0.00', currency: 'BRL' });
  });

  it('does not consider zero a positive amount', () => {
    expect(Money.zero('BRL').isPositive()).toBe(false);
  });

  it('cannot be mutated at runtime', () => {
    const money = Money.from({ amount: '1.00', currency: 'BRL' });

    expect(Reflect.set(money, 'currency', 'USD')).toBe(false);
    expect(money.toJSON()).toEqual({ amount: '1.00', currency: 'BRL' });
  });

  it('rejects invalid, non-finite, scientific, negative, and over-scale input amounts', () => {
    for (const amount of ['', 'NaN', 'Infinity', '-1.00', '1e3', '1.001']) {
      expect(() => Money.from({ amount, currency: 'BRL' })).toThrow(InvalidMoneyError);
    }
  });

  it('keeps arithmetic immutable and exposes negative intermediate results', () => {
    const original = Money.from({ amount: '2.40', currency: 'BRL' });
    const difference = original.subtract(Money.from({ amount: '3.00', currency: 'BRL' }));

    expect(original.toJSON()).toEqual({ amount: '2.40', currency: 'BRL' });
    expect(difference.toJSON()).toEqual({ amount: '-0.60', currency: 'BRL' });
    expect(difference.isNegative()).toBe(true);
    expect(original.negate().toJSON()).toEqual({ amount: '-2.40', currency: 'BRL' });
  });

  it('rejects arithmetic across currencies', () => {
    const brl = Money.from({ amount: '1.00', currency: 'BRL' });
    const usd = Money.from({ amount: '1.00', currency: 'USD' });

    expect(() => brl.add(usd)).toThrow(CurrencyMismatchError);
    expect(() => brl.isLessThan(usd)).toThrow(CurrencyMismatchError);
  });
});
