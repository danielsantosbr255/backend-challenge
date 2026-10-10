import { ApplicationError } from '@/common/errors/application.error';

export class InvalidMoneyError extends ApplicationError {
  constructor(message = 'Money must have a non-negative decimal amount with at most two decimal places and a three-letter currency code') {
    super('INVALID_MONEY', message);
    this.name = 'InvalidMoneyError';
  }
}

export class CurrencyMismatchError extends ApplicationError {
  constructor() {
    super('CURRENCY_MISMATCH', 'Money operations require matching currencies');
    this.name = 'CurrencyMismatchError';
  }
}

export class InvalidWalletError extends ApplicationError {
  constructor(message: string) {
    super('INVALID_WALLET', message);
    this.name = 'InvalidWalletError';
  }
}

export class InvalidPersistedWalletStateError extends ApplicationError {
  constructor(options?: ErrorOptions) {
    super('INVALID_PERSISTED_WALLET_STATE', 'Persisted wallet state is invalid', options);
    this.name = 'InvalidPersistedWalletStateError';
  }
}

export class InsufficientFundsError extends ApplicationError {
  constructor() {
    super('INSUFFICIENT_FUNDS', 'Wallet balance is insufficient');
    this.name = 'InsufficientFundsError';
  }
}

export class InvalidWalletMovementError extends ApplicationError {
  constructor() {
    super('INVALID_WALLET_MOVEMENT', 'Wallet movements require a non-negative amount');
    this.name = 'InvalidWalletMovementError';
  }
}

export class InvalidWalletLedgerEntryError extends ApplicationError {
  constructor(message: string) {
    super('INVALID_WALLET_LEDGER_ENTRY', message);
    this.name = 'InvalidWalletLedgerEntryError';
  }
}

export class WalletAlreadyExistsError extends ApplicationError {
  constructor() {
    super('WALLET_ALREADY_EXISTS', 'A wallet already exists for this player and currency');
    this.name = 'WalletAlreadyExistsError';
  }
}
