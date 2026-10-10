export type ApplicationErrorCode =
  | 'INVALID_MONEY'
  | 'CURRENCY_MISMATCH'
  | 'INVALID_WALLET'
  | 'INSUFFICIENT_FUNDS'
  | 'INVALID_WALLET_MOVEMENT'
  | 'INVALID_WALLET_LEDGER_ENTRY'
  | 'WALLET_ALREADY_EXISTS'
  | 'INVALID_PERSISTED_WALLET_STATE'
  | 'WAGER_RESERVATION_CONFLICT'
  | 'WAGER_IDEMPOTENCY_CONFLICT'
  | 'WAGER_EXTERNAL_TRANSACTION_CONFLICT'
  | 'WAGER_WALLET_NOT_FOUND'
  | 'WAGER_WALLET_MISMATCH'
  | 'INVALID_WAGER_AMOUNT'
  | 'WAGER_REFERENCE_NOT_FOUND'
  | 'WAGER_REFERENCE_MISMATCH'
  | 'INVALID_WAGER_TRANSACTION'
  | 'INVALID_WAGER_TRANSACTION_STATE'
  | 'INVALID_PERSISTED_WAGER_RESULT'
  | 'INVALID_WAGER_PROCESSING_STATE'
  | 'INVALID_WAGER_UNIT_OF_WORK_STATE';

export abstract class ApplicationError extends Error {
  protected constructor(
    public readonly code: ApplicationErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = new.target.name;
  }
}
