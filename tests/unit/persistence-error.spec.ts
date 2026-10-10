import { describe, expect, it } from 'bun:test';
import { DriverException } from '@mikro-orm/core';
import { PermanentInfrastructureError } from '@/common/errors/permanent-infrastructure.error';
import { TransientInfrastructureError } from '@/common/errors/transient-infrastructure.error';
import { isPersistenceLockConflict, rethrowPersistenceError } from '@/infrastructure/persistence/persistence-error';

describe('persistence failure classification', () => {
  it('keeps connection, recovery, resource and query timeout failures retryable', () => {
    for (const code of ['08006', '53300', '40001', '40P01', '55P03', '57014', '57P01', '57P02', '57P03']) {
      const error = new DriverException(Object.assign(new Error('private database details'), { code }));
      expect(() => rethrowPersistenceError(error)).toThrow(TransientInfrastructureError);
    }
  });

  it('recognizes network failures even when no SQLSTATE is available', () => {
    for (const code of ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ENETUNREACH', 'EHOSTUNREACH', 'EAI_AGAIN']) {
      expect(() => rethrowPersistenceError(Object.assign(new Error('connection failed'), { code })))
        .toThrow(TransientInfrastructureError);
    }
  });

  it('classifies driver schema, permission and constraint failures as permanent', () => {
    for (const code of ['42501', '42P01', '23514', '0A000']) {
      const error = new DriverException(Object.assign(new Error('private database details'), { code }));
      expect(() => rethrowPersistenceError(error)).toThrow(PermanentInfrastructureError);
    }
  });

  it('preserves unknown server and programming errors rather than assigning terminal semantics', () => {
    const errors = [new TypeError('programming error'), new DriverException(Object.assign(new Error('unknown failure'), { code: 'P0001' }))];
    for (const original of errors) {
      try {
        rethrowPersistenceError(original);
      } catch (error: unknown) {
        expect(error).toBe(original);
      }
    }
  });

  it('counts serialization, deadlock and lock timeout failures separately from connection failures', () => {
    expect(isPersistenceLockConflict(Object.assign(new Error(), { code: '40001' }))).toBe(true);
    expect(isPersistenceLockConflict(Object.assign(new Error(), { code: '40P01' }))).toBe(true);
    expect(isPersistenceLockConflict(Object.assign(new Error(), { code: '55P03' }))).toBe(true);
    expect(isPersistenceLockConflict(Object.assign(new Error(), { code: '08006' }))).toBe(false);
  });
});
