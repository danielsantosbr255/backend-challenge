import { exponentialBackoffSeconds } from '@/common/async/retry';
import type { PendingReferenceRetry } from '../wager.interface';

const MAX_REFERENCE_RETRY_SECONDS = 60;

export function nextReferenceRetry(attempts: number, now: Date): PendingReferenceRetry {
  const seconds = exponentialBackoffSeconds(attempts, MAX_REFERENCE_RETRY_SECONDS);
  return { attempts, nextAttemptAt: new Date(now.getTime() + seconds * 1000) };
}
