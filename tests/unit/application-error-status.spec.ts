import { describe, expect, it } from 'bun:test';
import { HttpStatus } from '@nestjs/common';
import {
  InvalidPersistedWalletStateError,
  WalletAlreadyExistsError,
} from '@/modules/wallet/wallet.errors';
import {
  InvalidPersistedWagerResultError,
  WagerWalletMismatchError,
} from '@/modules/wager/wager.errors';
import { getHttpStatusForApplicationError } from '@/infrastructure/http/application-error-status';

describe('application error HTTP mapping', () => {
  it('maps business conflicts and validation failures to distinct HTTP statuses', () => {
    expect(getHttpStatusForApplicationError(new WalletAlreadyExistsError())).toBe(HttpStatus.CONFLICT);
    expect(getHttpStatusForApplicationError(new WagerWalletMismatchError())).toBe(
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
  });

  it('keeps internal consistency errors as server errors', () => {
    expect(getHttpStatusForApplicationError(new InvalidPersistedWalletStateError())).toBe(
      HttpStatus.INTERNAL_SERVER_ERROR,
    );
    expect(getHttpStatusForApplicationError(new InvalidPersistedWagerResultError())).toBe(
      HttpStatus.INTERNAL_SERVER_ERROR,
    );
  });
});
