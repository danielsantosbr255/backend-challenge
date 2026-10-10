import { ConnectionException, DeadlockException, DriverException, LockWaitTimeoutException } from '@mikro-orm/core';
import { PermanentInfrastructureError } from '@/common/errors/permanent-infrastructure.error';
import { TransientInfrastructureError } from '@/common/errors/transient-infrastructure.error';

const TRANSIENT_CODES = new Set([
  '40001', '40P01', '55P03', '57014', '57P01', '57P02', '57P03',
  'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ENETUNREACH', 'EHOSTUNREACH', 'EAI_AGAIN',
]);

export function isPersistenceLockConflict(error: unknown): boolean {
  return error instanceof DeadlockException || error instanceof LockWaitTimeoutException ||
    ['40001', '40P01', '55P03'].includes(readErrorCode(error) ?? '');
}

export function rethrowPersistenceError(error: unknown): never {
  const code = readErrorCode(error);
  if (
    error instanceof ConnectionException || isPersistenceLockConflict(error) ||
    (code !== undefined && (TRANSIENT_CODES.has(code) || code.startsWith('08') || code.startsWith('53')))
  ) {
    throw new TransientInfrastructureError({ cause: error });
  }
  if (
    error instanceof DriverException && code !== undefined &&
    (code.startsWith('23') || code.startsWith('42') || code === '0A000')
  ) {
    throw new PermanentInfrastructureError({ cause: error });
  }
  throw error;
}

function readErrorCode(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined;
  if ('sqlState' in error && typeof error.sqlState === 'string') return error.sqlState;
  if ('code' in error && typeof error.code === 'string') return error.code;
  return undefined;
}
