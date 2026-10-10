import Decimal from 'decimal.js';
import { CurrencyMismatchError, InvalidMoneyError } from '../wallet.errors';

export interface MoneyProps {
  amount: string;
  currency: string;
}

const MAX_AMOUNT = new Decimal('9999999999999999.99');
const INPUT_AMOUNT_PATTERN = /^(?:0|[0-9]+)(?:\.[0-9]{1,2})?$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;

export class Money {
  private constructor(
    private readonly value: Decimal,
    public readonly currency: string,
  ) {
    Object.freeze(this);
  }

  static from(props: MoneyProps): Money {
    if (
      typeof props.currency !== 'string' ||
      typeof props.amount !== 'string' ||
      !CURRENCY_PATTERN.test(props.currency) ||
      !INPUT_AMOUNT_PATTERN.test(props.amount)
    ) {
      throw new InvalidMoneyError();
    }

    const value = new Decimal(props.amount);
    if (value.greaterThan(MAX_AMOUNT)) {
      throw new InvalidMoneyError('Money exceeds the NUMERIC(18,2) range');
    }

    return new Money(value, props.currency);
  }

  static zero(currency: string): Money {
    if (typeof currency !== 'string' || !CURRENCY_PATTERN.test(currency)) {
      throw new InvalidMoneyError('Currency must be a three-letter uppercase code');
    }

    return new Money(new Decimal(0), currency);
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.fromResult(this.value.plus(other.value), this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.fromResult(this.value.minus(other.value), this.currency);
  }

  negate(): Money {
    return Money.fromResult(this.value.negated(), this.currency);
  }

  isZero(): boolean {
    return this.value.isZero();
  }

  isPositive(): boolean {
    return this.value.greaterThan(0);
  }

  isNegative(): boolean {
    return this.value.isNegative();
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.value.lessThan(other.value);
  }

  equals(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.value.equals(other.value);
  }

  toJSON(): MoneyProps {
    return { amount: this.value.toFixed(2), currency: this.currency };
  }

  toString(): string {
    return `${this.value.toFixed(2)} ${this.currency}`;
  }

  private static fromResult(value: Decimal, currency: string): Money {
    if (value.abs().greaterThan(MAX_AMOUNT)) {
      throw new InvalidMoneyError('Money operation exceeds the NUMERIC(18,2) range');
    }

    return new Money(value, currency);
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new CurrencyMismatchError();
    }
  }
}
