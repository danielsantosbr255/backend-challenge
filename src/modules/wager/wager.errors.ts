import { ApplicationError } from '@/common/errors/application.error';

export type WagerReservationConflict = 'IDEMPOTENCY' | 'EXTERNAL_TRANSACTION';

const TERMINAL_WAGER_ERROR_CODES = new Set([
  'WAGER_EXTERNAL_TRANSACTION_CONFLICT',
  'WAGER_IDEMPOTENCY_CONFLICT',
  'WAGER_WALLET_NOT_FOUND',
  'WAGER_WALLET_MISMATCH',
  'INSUFFICIENT_FUNDS',
  'WAGER_REFERENCE_MISMATCH',
  'CURRENCY_MISMATCH',
]);

export function isTerminalWagerError(error: unknown): error is ApplicationError {
  return error instanceof ApplicationError && TERMINAL_WAGER_ERROR_CODES.has(error.code);
}

export class InboxMessageConflictError extends ApplicationError {
  constructor() {
    super('INBOX_MESSAGE_CONFLICT', 'Message ID was received with a different payload');
    this.name = 'InboxMessageConflictError';
  }
}

export class WagerReservationConflictError extends ApplicationError {
  constructor(public readonly conflict: WagerReservationConflict) {
    super('WAGER_RESERVATION_CONFLICT', `Wager reservation conflict: ${conflict}`);
    this.name = 'WagerReservationConflictError';
  }
}

export class WagerIdempotencyConflictError extends ApplicationError {
  constructor() {
    super('WAGER_IDEMPOTENCY_CONFLICT', 'Idempotency key was already used with a different payload');
    this.name = 'WagerIdempotencyConflictError';
  }
}

export class WagerExternalTransactionConflictError extends ApplicationError {
  constructor() {
    super('WAGER_EXTERNAL_TRANSACTION_CONFLICT', 'External transaction ID was already used');
    this.name = 'WagerExternalTransactionConflictError';
  }
}

export class WagerWalletNotFoundError extends ApplicationError {
  constructor() {
    super('WAGER_WALLET_NOT_FOUND', 'Wallet was not found');
    this.name = 'WagerWalletNotFoundError';
  }
}

export class WagerWalletMismatchError extends ApplicationError {
  constructor() {
    super('WAGER_WALLET_MISMATCH', 'Wallet does not match the supplied player or currency');
    this.name = 'WagerWalletMismatchError';
  }
}

export class InvalidWagerAmountError extends ApplicationError {
  constructor() {
    super('INVALID_WAGER_AMOUNT', 'Wager amount must be positive');
    this.name = 'InvalidWagerAmountError';
  }
}

export class WagerReferenceNotFoundError extends ApplicationError {
  constructor() {
    super('WAGER_REFERENCE_NOT_FOUND', 'Referenced wager transaction was not found');
    this.name = 'WagerReferenceNotFoundError';
  }
}

export class WagerReferenceMismatchError extends ApplicationError {
  constructor() {
    super('WAGER_REFERENCE_MISMATCH', 'Referenced wager transaction does not match this wager');
    this.name = 'WagerReferenceMismatchError';
  }
}

export class InvalidWagerTransactionError extends ApplicationError {
  constructor(message: string) {
    super('INVALID_WAGER_TRANSACTION', message);
    this.name = 'InvalidWagerTransactionError';
  }
}

export class InvalidWagerTransactionStateError extends ApplicationError {
  constructor(status: string) {
    super('INVALID_WAGER_TRANSACTION_STATE', `Cannot change a wager transaction in ${status} state`);
    this.name = 'InvalidWagerTransactionStateError';
  }
}

export class InvalidPersistedWagerResultError extends ApplicationError {
  constructor() {
    super('INVALID_PERSISTED_WAGER_RESULT', 'Persisted wager result is incomplete');
    this.name = 'InvalidPersistedWagerResultError';
  }
}

export class InvalidWagerProcessingStateError extends ApplicationError {
  constructor() {
    super('INVALID_WAGER_PROCESSING_STATE', 'Wager processing did not reach a terminal status');
    this.name = 'InvalidWagerProcessingStateError';
  }
}

export class InvalidWagerUnitOfWorkStateError extends ApplicationError {
  constructor() {
    super('INVALID_WAGER_UNIT_OF_WORK_STATE', 'Wager transaction was not reserved and wallet was not locked');
    this.name = 'InvalidWagerUnitOfWorkStateError';
  }
}
