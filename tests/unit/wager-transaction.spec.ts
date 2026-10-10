import { describe, expect, it } from 'bun:test';
import { Money } from '@/modules/wallet/domain/money';
import {
  WagerTransaction,
  type CreateWagerTransactionProps,
} from '@/modules/wager/domain/wager-transaction';
import { InvalidWagerTransactionError, InvalidWagerTransactionStateError } from '@/modules/wager/wager.errors';

describe('WagerTransaction', () => {
  it('creates a pending wager and identifies balance effects by kind', () => {
    const transaction = WagerTransaction.create(transactionProps());

    expect(transaction.status).toBe('PENDING');
    expect(transaction.affectsBalance()).toBe(true);
    expect(transaction.ledgerDirectionFor()).toBe('DEBIT');
  });

  it('records LOSS without a ledger effect and credits WIN', () => {
    const loss = WagerTransaction.create(transactionProps({ kind: 'LOSS' }));
    const win = WagerTransaction.create(transactionProps({ kind: 'WIN' }));

    expect(loss.affectsBalance()).toBe(false);
    expect(loss.ledgerDirectionFor()).toBeUndefined();
    expect(win.affectsBalance()).toBe(true);
    expect(win.ledgerDirectionFor()).toBe('CREDIT');
  });

  it('requires references for REFUND and ROLLBACK and inverts the referenced direction', () => {
    expect(() => WagerTransaction.create(transactionProps({ kind: 'REFUND' }))).toThrow(
      InvalidWagerTransactionError,
    );
    expect(() => WagerTransaction.create(transactionProps({ kind: 'ROLLBACK' }))).toThrow(
      InvalidWagerTransactionError,
    );

    const refund = WagerTransaction.create(
      transactionProps({ kind: 'REFUND', referenceExternalTransactionId: 'bet-1' }),
    );
    const rollback = WagerTransaction.create(
      transactionProps({ kind: 'ROLLBACK', referenceExternalTransactionId: 'win-1' }),
    );
    const bet = WagerTransaction.create(transactionProps({ kind: 'BET' }));
    const win = WagerTransaction.create(transactionProps({ kind: 'WIN' }));

    expect(refund.requiresReference()).toBe(true);
    expect(refund.ledgerDirectionFor()).toBe('CREDIT');
    expect(rollback.ledgerDirectionFor(win)).toBe('DEBIT');
    expect(rollback.ledgerDirectionFor(bet)).toBe('CREDIT');
    expect(() => rollback.ledgerDirectionFor()).toThrow(InvalidWagerTransactionError);
  });

  it('keeps OPENING internal and creates it as an already processed credit', () => {
    const opening = WagerTransaction.opening({
      id: '0199c2a0-0000-7000-8000-000000000003',
      walletId: '0199c2a0-0000-7000-8000-000000000001',
      playerId: '0199c2a0-0000-7000-8000-000000000002',
      money: Money.from({ amount: '5.00', currency: 'BRL' }),
      createdAt: new Date('2026-10-09T12:00:00.000Z'),
    });

    expect(opening.kind).toBe('OPENING');
    expect(opening.status).toBe('PROCESSED');
    expect(opening.ledgerDirectionFor()).toBe('CREDIT');
    expect(opening.matchesPayload(opening.payloadHash)).toBe(true);
  });

  it('allows pending references to resolve once and keeps terminal statuses immutable', () => {
    const transaction = WagerTransaction.create(
      transactionProps({ kind: 'REFUND', referenceExternalTransactionId: 'bet-1' }),
    );
    transaction.markPendingReference();
    expect(transaction.status).toBe('PENDING_REFERENCE');
    transaction.markProcessed('0199c2a0-0000-7000-8000-000000000005', new Date());
    expect(transaction.status).toBe('PROCESSED');
    expect(transaction.isTerminal()).toBe(true);
    expect(() => transaction.reject('INVALID')).toThrow(InvalidWagerTransactionStateError);
  });
});

function transactionProps(
  overrides: Partial<CreateWagerTransactionProps> = {},
): CreateWagerTransactionProps {
  return {
    id: '0199c2a0-0000-7000-8000-000000000003',
    providerId: 'provider-a',
    externalTransactionId: 'external-1',
    idempotencyKey: 'provider-a:external-1',
    payloadHash: 'a'.repeat(64),
    walletId: '0199c2a0-0000-7000-8000-000000000001',
    playerId: '0199c2a0-0000-7000-8000-000000000002',
    roundId: 'round-1',
    gameId: 'game-1',
    kind: 'BET',
    money: Money.from({ amount: '5.00', currency: 'BRL' }),
    createdAt: new Date('2026-10-09T12:00:00.000Z'),
    ...overrides,
  };
}
