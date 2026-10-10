import { CurrencyMismatchError, Money, type MoneyProps } from './money';

export interface WalletProps {
  id: string;
  playerId: string;
  initialBalance: Money;
  openedAt?: Date;
}

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: MoneyProps;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface BalanceChange {
  balanceBefore: Money;
  balanceAfter: Money;
  version: number;
  changed: boolean;
}

export class InvalidWalletError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidWalletError';
  }
}

export class InsufficientFundsError extends Error {
  constructor() {
    super('Wallet balance is insufficient');
    this.name = 'InsufficientFundsError';
  }
}

export class InvalidWalletMovementError extends Error {
  constructor() {
    super('Wallet movements require a non-negative amount');
    this.name = 'InvalidWalletMovementError';
  }
}

export class Wallet {
  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private _balance: Money,
    private _version: number,
    private _createdAt: Date,
    private _updatedAt: Date,
  ) {}

  static open(props: WalletProps): Wallet {
    if (props.id.trim().length === 0 || props.playerId.trim().length === 0) {
      throw new InvalidWalletError('Wallet and player IDs are required');
    }
    if (props.initialBalance.isNegative()) {
      throw new InvalidWalletError('Wallet initial balance cannot be negative');
    }

    const openedAt = copyValidDate(props.openedAt ?? new Date(), 'Wallet opening time');
    return new Wallet(
      props.id,
      props.playerId,
      props.initialBalance.currency,
      props.initialBalance,
      1,
      openedAt,
      new Date(openedAt),
    );
  }

  static rehydrate(state: WalletState): Wallet {
    if (state.id.trim().length === 0 || state.playerId.trim().length === 0) {
      throw new InvalidWalletError('Wallet and player IDs are required');
    }
    if (!Number.isInteger(state.version) || state.version < 1) {
      throw new InvalidWalletError('Persisted wallet version must be a positive integer');
    }

    const balance = Money.from(state.balance);
    if (balance.currency !== state.currency) {
      throw new CurrencyMismatchError();
    }

    return new Wallet(
      state.id,
      state.playerId,
      state.currency,
      balance,
      state.version,
      copyValidDate(state.createdAt, 'Wallet creation time'),
      copyValidDate(state.updatedAt, 'Wallet update time'),
    );
  }

  get balance(): Money {
    return this._balance;
  }

  get createdAt(): Date {
    return new Date(this._createdAt);
  }

  get version(): number {
    return this._version;
  }

  get updatedAt(): Date {
    return new Date(this._updatedAt);
  }

  debit(amount: Money, at: Date): BalanceChange {
    this.assertSameCurrency(amount);
    this.assertNonNegative(amount);
    if (this._balance.isLessThan(amount)) {
      throw new InsufficientFundsError();
    }

    return this.applyBalance(this._balance.subtract(amount), at);
  }

  credit(amount: Money, at: Date): BalanceChange {
    this.assertSameCurrency(amount);
    this.assertNonNegative(amount);
    return this.applyBalance(this._balance.add(amount), at);
  }

  private applyBalance(balanceAfter: Money, at: Date): BalanceChange {
    const balanceBefore = this._balance;
    const changed = !balanceBefore.equals(balanceAfter);
    if (changed) {
      const updatedAt = copyValidDate(at, 'Wallet update time');
      this._balance = balanceAfter;
      this._version += 1;
      this._updatedAt = updatedAt;
    }

    return {
      balanceBefore,
      balanceAfter: this._balance,
      version: this._version,
      changed,
    };
  }

  private assertSameCurrency(money: Money): void {
    if (this.currency !== money.currency) {
      throw new CurrencyMismatchError();
    }
  }

  private assertNonNegative(money: Money): void {
    if (money.isNegative()) {
      throw new InvalidWalletMovementError();
    }
  }
}

function copyValidDate(value: Date, label: string): Date {
  if (!Number.isFinite(value.getTime())) {
    throw new InvalidWalletError(`${label} must be valid`);
  }

  return new Date(value);
}
