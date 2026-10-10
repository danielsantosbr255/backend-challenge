import { createHash } from 'node:crypto';
import { Money, type MoneyProps } from '@/modules/wallet/domain/money';
import type { LedgerDirection } from '@/modules/wallet/domain/wallet-ledger-entry';
import { InvalidWagerTransactionError, InvalidWagerTransactionStateError } from '../wager.errors';

export type WagerKind = 'OPENING' | 'BET' | 'WIN' | 'LOSS' | 'REFUND' | 'ROLLBACK';
export type WagerStatus = 'PENDING' | 'PENDING_REFERENCE' | 'PROCESSED' | 'REJECTED' | 'FAILED';
export type ExternalWagerKind = Exclude<WagerKind, 'OPENING'>;

export interface CreateWagerTransactionProps {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: ExternalWagerKind;
  money: Money;
  referenceExternalTransactionId?: string;
  createdAt: Date;
}

export interface CreateOpeningTransactionProps {
  id: string;
  walletId: string;
  playerId: string;
  money: Money;
  createdAt: Date;
}

export interface WagerTransactionState {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerKind;
  money: MoneyProps;
  referenceExternalTransactionId?: string;
  createdAt: Date;
  status: WagerStatus;
  referenceTransactionId?: string;
  failureCode?: string;
  processedAt?: Date;
}

export class WagerTransaction {
  private constructor(
    public readonly id: string,
    public readonly providerId: string,
    public readonly externalTransactionId: string,
    public readonly idempotencyKey: string,
    public readonly payloadHash: string,
    public readonly walletId: string,
    public readonly playerId: string,
    public readonly roundId: string,
    public readonly gameId: string,
    public readonly kind: WagerKind,
    public readonly money: Money,
    private _referenceExternalTransactionId: string | undefined,
    private _createdAt: Date,
    private _status: WagerStatus,
    private _referenceTransactionId?: string,
    private _failureCode?: string,
    private _processedAt?: Date,
  ) {}

  static create(props: CreateWagerTransactionProps): WagerTransaction {
    assertRequired(props.id, 'Transaction ID');
    assertRequired(props.providerId, 'Provider ID');
    assertRequired(props.externalTransactionId, 'External transaction ID');
    assertRequired(props.idempotencyKey, 'Idempotency key');
    assertHash(props.payloadHash);
    assertRequired(props.walletId, 'Wallet ID');
    assertRequired(props.playerId, 'Player ID');
    assertRequired(props.roundId, 'Round ID');
    assertRequired(props.gameId, 'Game ID');

    assertExternalKind(props.kind);
    if (requiresReference(props.kind) && !props.referenceExternalTransactionId) {
      throw new InvalidWagerTransactionError(`${props.kind} requires a reference transaction`);
    }

    return new WagerTransaction(
      props.id,
      props.providerId,
      props.externalTransactionId,
      props.idempotencyKey,
      props.payloadHash,
      props.walletId,
      props.playerId,
      props.roundId,
      props.gameId,
      props.kind,
      props.money,
      props.referenceExternalTransactionId,
      copyValidDate(props.createdAt),
      'PENDING',
    );
  }

  static opening(props: CreateOpeningTransactionProps): WagerTransaction {
    assertRequired(props.id, 'Transaction ID');
    assertRequired(props.walletId, 'Wallet ID');
    assertRequired(props.playerId, 'Player ID');
    if (!props.money.isPositive()) {
      throw new InvalidWagerTransactionError('OPENING requires a positive amount');
    }

    const createdAt = copyValidDate(props.createdAt);
    const businessData = JSON.stringify({
      walletId: props.walletId,
      playerId: props.playerId,
      amount: props.money.toJSON().amount,
      currency: props.money.currency,
      kind: 'OPENING',
    });
    const payloadHash = createHash('sha256').update(businessData).digest('hex');

    return new WagerTransaction(
      props.id,
      'internal',
      props.id,
      `wallet-opening:${props.walletId}`,
      payloadHash,
      props.walletId,
      props.playerId,
      'wallet-opening',
      'internal',
      'OPENING',
      props.money,
      undefined,
      createdAt,
      'PROCESSED',
      undefined,
      undefined,
      createdAt,
    );
  }

  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(
      state.id,
      state.providerId,
      state.externalTransactionId,
      state.idempotencyKey,
      state.payloadHash,
      state.walletId,
      state.playerId,
      state.roundId,
      state.gameId,
      state.kind,
      Money.from(state.money),
      state.referenceExternalTransactionId,
      copyValidDate(state.createdAt),
      state.status,
      state.referenceTransactionId,
      state.failureCode,
      state.processedAt === undefined ? undefined : copyValidDate(state.processedAt),
    );
  }

  get status(): WagerStatus {
    return this._status;
  }

  get referenceExternalTransactionId(): string | undefined {
    return this._referenceExternalTransactionId;
  }

  get referenceTransactionId(): string | undefined {
    return this._referenceTransactionId;
  }

  get failureCode(): string | undefined {
    return this._failureCode;
  }

  get createdAt(): Date {
    return new Date(this._createdAt);
  }

  get processedAt(): Date | undefined {
    return this._processedAt === undefined ? undefined : new Date(this._processedAt);
  }

  markProcessed(referenceTransactionId: string | undefined, at: Date): void {
    this.assertCanTransition();
    if (requiresReference(this.kind) && referenceTransactionId === undefined) {
      throw new InvalidWagerTransactionError(`${this.kind} requires a resolved reference transaction`);
    }

    const processedAt = copyValidDate(at);
    this._referenceTransactionId = referenceTransactionId;
    this._processedAt = processedAt;
    this._failureCode = undefined;
    this._status = 'PROCESSED';
  }

  markPendingReference(): void {
    this.assertCanTransition();
    if (!requiresReference(this.kind)) {
      throw new InvalidWagerTransactionError(`${this.kind} does not require a reference transaction`);
    }

    this._status = 'PENDING_REFERENCE';
  }

  reject(code: string): void {
    this.markTerminalFailure('REJECTED', code);
  }

  fail(code: string): void {
    this.markTerminalFailure('FAILED', code);
  }

  isTerminal(): boolean {
    return this._status === 'PROCESSED' || this._status === 'REJECTED' || this._status === 'FAILED';
  }

  affectsBalance(): boolean {
    return this.kind !== 'LOSS';
  }

  requiresReference(): boolean {
    return requiresReference(this.kind);
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection | undefined {
    switch (this.kind) {
      case 'OPENING':
      case 'WIN':
      case 'REFUND':
        return 'CREDIT';
      case 'BET':
        return 'DEBIT';
      case 'LOSS':
        return undefined;
      case 'ROLLBACK': {
        if (reference === undefined) {
          throw new InvalidWagerTransactionError('ROLLBACK requires a resolved reference transaction');
        }
        const direction = reference.ledgerDirectionFor();
        if (direction === undefined) {
          throw new InvalidWagerTransactionError('ROLLBACK cannot reverse a transaction without a ledger entry');
        }
        return direction === 'CREDIT' ? 'DEBIT' : 'CREDIT';
      }
    }
  }

  private markTerminalFailure(status: 'REJECTED' | 'FAILED', code: string): void {
    this.assertCanTransition();
    assertRequired(code, 'Failure code');
    this._failureCode = code;
    this._status = status;
  }

  private assertCanTransition(): void {
    if (this.isTerminal()) {
      throw new InvalidWagerTransactionStateError(this._status);
    }
  }
}

function requiresReference(kind: WagerKind): boolean {
  return kind === 'REFUND' || kind === 'ROLLBACK';
}

function assertExternalKind(kind: WagerKind): asserts kind is ExternalWagerKind {
  if (kind === 'OPENING') {
    throw new InvalidWagerTransactionError('OPENING transactions are internal');
  }
}

function assertRequired(value: string, label: string): void {
  if (value.trim().length === 0) {
    throw new InvalidWagerTransactionError(`${label} is required`);
  }
}

function assertHash(value: string): void {
  if (!/^[0-9a-f]{64}$/.test(value)) {
    throw new InvalidWagerTransactionError('Payload hash must be a SHA-256 hex digest');
  }
}

function copyValidDate(value: Date): Date {
  if (!Number.isFinite(value.getTime())) {
    throw new InvalidWagerTransactionError('Transaction time must be valid');
  }

  return new Date(value);
}
