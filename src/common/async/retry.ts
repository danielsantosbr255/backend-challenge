export function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function exponentialBackoffSeconds(attempt: number, maximumSeconds: number): number {
  const safeAttempt = Number.isFinite(attempt) ? Math.max(1, Math.trunc(attempt)) : 1;
  const exponent = Math.min(safeAttempt - 1, 30);
  return Math.min(maximumSeconds, 2 ** exponent);
}
