import { Money, type MoneyProps } from './money';
import { CurrencyMismatchError, InvalidWalletLedgerEntryError } from '../wallet.errors';

export type LedgerDirection = 'DEBIT' | 'CREDIT';

export interface CreateWalletLedgerEntryProps {
  id: string;
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  amount: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  createdAt: Date;
}

export interface WalletLedgerEntryState {
  id: string;
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  amount: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  createdAt: Date;
}

export class WalletLedgerEntry {
  private constructor(
    public readonly id: string,
    public readonly walletId: string,
    public readonly transactionId: string,
    public readonly direction: LedgerDirection,
    public readonly amount: Money,
    public readonly balanceBefore: Money,
    public readonly balanceAfter: Money,
    private _createdAt: Date,
  ) {
    Object.freeze(this);
  }

  static create(props: CreateWalletLedgerEntryProps): WalletLedgerEntry {
    assertIdentity(props.id, 'Ledger entry ID');
    assertIdentity(props.walletId, 'Wallet ID');
    assertIdentity(props.transactionId, 'Transaction ID');
    assertDirection(props.direction);
    assertSameCurrency(props.amount, props.balanceBefore, props.balanceAfter);

    if (!props.amount.isPositive()) {
      throw new InvalidWalletLedgerEntryError('Ledger entry amount must be positive');
    }
    if (props.balanceBefore.isNegative() || props.balanceAfter.isNegative()) {
      throw new InvalidWalletLedgerEntryError('Ledger balances cannot be negative');
    }

    const entry = new WalletLedgerEntry(
      props.id,
      props.walletId,
      props.transactionId,
      props.direction,
      props.amount,
      props.balanceBefore,
      props.balanceAfter,
      copyValidDate(props.createdAt),
    );

    if (!entry.isBalanced()) {
      throw new InvalidWalletLedgerEntryError('Ledger entry arithmetic is not balanced');
    }

    return entry;
  }

  static rehydrate(state: WalletLedgerEntryState): WalletLedgerEntry {
    assertDirection(state.direction);
    return new WalletLedgerEntry(
      state.id,
      state.walletId,
      state.transactionId,
      state.direction,
      Money.from(state.amount),
      Money.from(state.balanceBefore),
      Money.from(state.balanceAfter),
      copyValidDate(state.createdAt),
    );
  }

  get createdAt(): Date {
    return new Date(this._createdAt);
  }

  isBalanced(): boolean {
    if (
      this.amount.currency !== this.balanceBefore.currency ||
      this.amount.currency !== this.balanceAfter.currency ||
      !this.amount.isPositive() ||
      this.balanceBefore.isNegative() ||
      this.balanceAfter.isNegative()
    ) {
      return false;
    }

    const expectedBalance =
      this.direction === 'CREDIT'
        ? this.balanceBefore.add(this.amount)
        : this.balanceBefore.subtract(this.amount);
    return expectedBalance.equals(this.balanceAfter);
  }
}

function assertSameCurrency(amount: Money, balanceBefore: Money, balanceAfter: Money): void {
  if (
    amount.currency !== balanceBefore.currency ||
    amount.currency !== balanceAfter.currency
  ) {
    throw new CurrencyMismatchError();
  }
}

function assertIdentity(value: string, label: string): void {
  if (value.trim().length === 0) {
    throw new InvalidWalletLedgerEntryError(`${label} is required`);
  }
}

function assertDirection(direction: LedgerDirection): void {
  if (direction !== 'DEBIT' && direction !== 'CREDIT') {
    throw new InvalidWalletLedgerEntryError('Ledger direction is invalid');
  }
}

function copyValidDate(value: Date): Date {
  if (!Number.isFinite(value.getTime())) {
    throw new InvalidWalletLedgerEntryError('Ledger entry time must be valid');
  }

  return new Date(value);
}
