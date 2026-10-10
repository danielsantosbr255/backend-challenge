import type { MikroORM } from '@mikro-orm/core';

/** Hold a real PostgreSQL lock at the outbox write, after the wager was reserved. */
export async function withBlockedOutbox(
  orm: MikroORM,
  providerId: string,
  externalTransactionId: string,
  work: () => Promise<void>,
): Promise<void> {
  const triggerName = `test_timeout_outbox_${crypto.randomUUID().replaceAll('-', '')}`;
  const lockId = crypto.getRandomValues(new Uint32Array(1))[0];
  const connection = orm.em.getConnection();
  await connection.execute(
    `CREATE FUNCTION ${triggerName}() RETURNS trigger AS $$
     BEGIN
       IF NEW.payload->'data'->>'providerId' = TG_ARGV[0]
         AND NEW.payload->'data'->>'externalTransactionId' = TG_ARGV[1] THEN
         PERFORM set_config('lock_timeout', '100ms', true);
         PERFORM pg_advisory_xact_lock(TG_ARGV[2]::bigint);
       END IF;
       RETURN NEW;
     END; $$ LANGUAGE plpgsql`,
  );
  await connection.execute(
    `CREATE TRIGGER ${triggerName} BEFORE INSERT ON outbox_messages
     FOR EACH ROW EXECUTE FUNCTION ${triggerName}(?, ?, ?)`,
    [providerId, externalTransactionId, String(lockId)],
  );

  let signalLocked: (() => void) | undefined;
  let rejectLocked: ((reason: unknown) => void) | undefined;
  let releaseLock: (() => void) | undefined;
  const locked = new Promise<void>((resolve, reject) => { signalLocked = resolve; rejectLocked = reject; });
  const released = new Promise<void>((resolve) => { releaseLock = resolve; });
  const blocker = orm.em.fork().transactional(async (em) => {
    // This test deliberately keeps a transaction idle while the broker performs bounded retries.
    await em.getConnection().execute("SELECT set_config('idle_in_transaction_session_timeout', '0', true)", [], 'all', em.getTransactionContext());
    await em.getConnection().execute('SELECT pg_advisory_xact_lock(?::bigint)', [lockId], 'all', em.getTransactionContext());
    signalLocked?.();
    await released;
  });
  void blocker.catch((error: unknown) => rejectLocked?.(error));

  try {
    await locked;
    await work();
  } finally {
    releaseLock?.();
    try {
      await blocker;
    } finally {
      await connection.execute(`DROP TRIGGER ${triggerName} ON outbox_messages`);
      await connection.execute(`DROP FUNCTION ${triggerName}()`);
    }
  }
}
