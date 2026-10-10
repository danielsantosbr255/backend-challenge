import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { MikroORM } from '@mikro-orm/core';
import { Migrator } from '@mikro-orm/migrations';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { Module, ValidationPipe, type INestApplication } from '@nestjs/common';
import { APP_FILTER, NestFactory } from '@nestjs/core';
import { WalletModule } from '@/modules/wallet/wallet.module';
import { WagerModule } from '@/modules/wager/wager.module';
import { mikroOrmConfig } from '@/infrastructure/persistence/mikro-orm.config';
import { GlobalHttpExceptionFilter } from '@/infrastructure/http/global-http-exception.filter';
import { ProcessWagerUseCase } from '@/modules/wager/use-cases/process-wager.use-case';
import { ProcessPendingWagerReferencesUseCase } from '@/modules/wager/use-cases/process-pending-wager-references.use-case';
import { Money } from '@/modules/wallet/domain/money';
import { MetricsService } from '@/common/observability/metrics.service';
import { withBlockedOutbox } from './helpers/blocked-outbox';

let testOrm: MikroORM;
let testApp: INestApplication;
let testBaseUrl: string;
const integrationRunId = crypto.randomUUID();
const integrationProviderId = `integration-${integrationRunId}`;

@Module({
  imports: [
    MikroOrmModule.forRoot({ ...mikroOrmConfig, extensions: [Migrator] }),
    WalletModule,
    WagerModule,
  ],
  providers: [{ provide: APP_FILTER, useClass: GlobalHttpExceptionFilter }],
})
class WageringHttpTestModule {}

describe('Wagering HTTP processing', () => {
  beforeAll(async () => {
    testApp = await NestFactory.create(WageringHttpTestModule, { logger: false });
    testApp.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    testOrm = testApp.get(MikroORM);
    await testOrm.migrator.up();
    await testApp.listen(0, '127.0.0.1');
    testBaseUrl = await testApp.getUrl();
  }, 30_000);

  afterAll(async () => {
    await testApp?.close();
  }, 30_000);

  it.each([undefined, null, 'invalid', 1, true, [], [{ amount: '10.00', currency: 'BRL' }], {}, { amount: '10.00' }].map((value): [unknown] => [value]))(
    'rejects invalid initialBalance (%j) with HTTP 400 before creating a wallet', async (initialBalance: unknown) => {
      const playerId = crypto.randomUUID();
      const response = await fetch(`${testBaseUrl}/wallets`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ playerId, initialBalance }),
      });
      expect(response.status).toBe(400);
      const rows = await testOrm.em.getConnection().execute<Array<{ count: number }>>(
        'SELECT count(*)::int AS count FROM wallets WHERE player_id = ?', [playerId],
      );
      expect(rows[0]?.count).toBe(0);
    },
  );

  it.each([undefined, null, 'invalid', 1, true, [], [{ amount: '10.00', currency: 'BRL' }], {}, { amount: '10.00' }].map((value): [unknown] => [value]))(
    'rejects invalid money (%j) with HTTP 400 without persisting financial effects', async (money: unknown) => {
      const walletId = await createWallet('100.00');
      const request = wagerRequest(walletId, crypto.randomUUID(), '10.00');
      const response = await fetch(`${testBaseUrl}/wagering/transactions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': request.key },
        body: JSON.stringify({ ...request.body, money }),
      });
      expect(response.status).toBe(400);
      expect(await readBalance(walletId)).toBe('100.00');
      expect(await financialCounts(walletId)).toEqual({ transactions: 1, ledger: 1, outbox: 2 });
    },
  );

  it('rejects an invented currency code before wallet creation', async () => {
    const response = await fetch(`${testBaseUrl}/wallets`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ playerId: crypto.randomUUID(), initialBalance: { amount: '10.00', currency: 'ZZZ' } }),
    });
    expect(response.status).toBe(400);
  });

  it('records both opening events in the same commit as a positive initial balance', async () => {
    const walletId = await createWallet('100.00');
    const rows: Array<{ event_type: string; transaction_id: string; balance: string }> = await testOrm.em.getConnection().execute(
      `SELECT event_type, payload->'data'->>'transactionId' AS transaction_id,
              COALESCE(payload->'data'->'balance'->>'amount', payload->'data'->'balanceAfter'->>'amount') AS balance
       FROM outbox_messages WHERE aggregate_id = ? ORDER BY event_type`, [walletId],
    );
    expect(rows.map((row) => row.event_type)).toEqual(['WagerTransactionProcessed', 'WalletBalanceChanged']);
    expect(new Set(rows.map((row) => row.transaction_id)).size).toBe(1);
    expect(rows.every((row) => row.balance === '100.00')).toBe(true);
  });

  it('rolls back wallet, opening, ledger and events when opening outbox persistence fails', async () => {
    const playerId = crypto.randomUUID();
    const triggerName = `reject_opening_outbox_${integrationRunId.replaceAll('-', '')}`;
    const connection = testOrm.em.getConnection();
    const countArtifacts = () => connection.execute<Array<{ ledger: number; outbox: number }>>(
      'SELECT (SELECT count(*)::int FROM wallet_ledger_entries) AS ledger, (SELECT count(*)::int FROM outbox_messages) AS outbox',
    );
    const before = await countArtifacts();
    await connection.execute(`CREATE FUNCTION ${triggerName}() RETURNS trigger AS $$
      BEGIN
        IF NEW.payload->'data'->>'providerId' = 'internal'
          AND NEW.payload->'data'->'balance'->>'amount' = '123.45' THEN
          RAISE EXCEPTION 'forced opening outbox failure' USING ERRCODE = '42501';
        END IF;
        RETURN NEW;
      END; $$ LANGUAGE plpgsql`);
    await connection.execute(`CREATE TRIGGER ${triggerName} BEFORE INSERT ON outbox_messages
      FOR EACH ROW EXECUTE FUNCTION ${triggerName}()`);
    try {
      const response = await fetch(`${testBaseUrl}/wallets`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ playerId, initialBalance: { amount: '123.45', currency: 'BRL' } }),
      });
      expect(response.status).toBe(500);
      const rows = await connection.execute<Array<{ wallets: number; wagers: number }>>(
        `SELECT (SELECT count(*)::int FROM wallets WHERE player_id = ?) AS wallets,
                (SELECT count(*)::int FROM wager_transactions WHERE player_id = ?) AS wagers`, [playerId, playerId],
      );
      expect(rows[0]).toEqual({ wallets: 0, wagers: 0 });
      expect(await countArtifacts()).toEqual(before);
    } finally {
      await connection.execute(`DROP TRIGGER ${triggerName} ON outbox_messages`);
      await connection.execute(`DROP FUNCTION ${triggerName}()`);
    }
  });

  it('allows a wager to retry after a real PostgreSQL lock timeout without retaining a failed operation', async () => {
    const walletId = await createWallet('100.00');
    const request = wagerRequest(walletId, 'recoverable-lock-timeout', '10.00');
    await withBlockedOutbox(testOrm, integrationProviderId, request.body.externalTransactionId, async () => {
      const timedOut = await submit(request);
      expect(timedOut.status).toBe(503);
      expect(await timedOut.text()).not.toContain('lock timeout');
      expect(await testApp.get(MetricsService).metrics()).toContain('wager_lock_conflicts_total 1');
      expect(await readBalance(walletId)).toBe('100.00');
      expect(await financialCounts(walletId)).toEqual({ transactions: 1, ledger: 1, outbox: 2 });
      const transactionQuery = await fetch(
        `${testBaseUrl}/providers/${integrationProviderId}/wagering/transactions/recoverable-lock-timeout`,
      );
      expect(transactionQuery.status).toBe(404);
    });

    const recovered = await submit(request);
    expect(recovered.status).toBe(200);
    expect(await readWagerResponse(recovered)).toMatchObject({ status: 'PROCESSED', idempotentReplay: false });
    expect(await readBalance(walletId)).toBe('90.00');
    expect(await financialCounts(walletId)).toEqual({ transactions: 2, ledger: 2, outbox: 4 });
    const replay = await submit(request);
    expect(await readWagerResponse(replay)).toMatchObject({ status: 'PROCESSED', idempotentReplay: true });
    const reconciliation = await fetch(`${testBaseUrl}/wallets/${walletId}/reconciliation`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ walletId }),
    });
    expect(await reconciliation.json()).toMatchObject({ consistent: true, calculatedBalance: { amount: '90.00' } });
  });

  it('applies one debit for 50 parallel deliveries of the same wager and replays the original result', async () => {
    const walletId = await createWallet('100.00');
    const request = wagerRequest(walletId, 'parallel-identical', '80.00');
    const results = await Promise.all(Array.from({ length: 50 }, () => submit(request)));

    expect(results.every((result) => result.status === 200)).toBe(true);
    const bodies = await Promise.all(results.map(readWagerResponse));
    expect(bodies.filter((body) => body.idempotentReplay)).toHaveLength(49);
    expect(new Set(bodies.map((body) => body.transactionId)).size).toBe(1);
    expect(new Set(bodies.map((body) => body.balance.amount))).toEqual(new Set(['20.00']));
    expect(await financialCounts(walletId)).toEqual({ transactions: 2, ledger: 2, outbox: 4 });
    expect(await readBalance(walletId)).toBe('20.00');
  }, 30_000);

  it('serializes competing bets on one wallet and rejects the debit that would overdraw it', async () => {
    const walletId = await createWallet('100.00');
    const requests = [
      wagerRequest(walletId, 'parallel-bet-a', '80.00'),
      wagerRequest(walletId, 'parallel-bet-b', '80.00'),
    ];
    const responses = await Promise.all(requests.map(submit));
    const bodies = await Promise.all(responses.map(readWagerResponse));

    expect(responses.map((response) => response.status).sort()).toEqual([200, 422]);
    expect(bodies.map((body) => body.status).sort()).toEqual(['PROCESSED', 'REJECTED']);
    expect(bodies.find((body) => body.status === 'REJECTED')?.failureCode).toBe('INSUFFICIENT_FUNDS');
    expect(await readBalance(walletId)).toBe('20.00');
    expect(await financialCounts(walletId)).toEqual({ transactions: 3, ledger: 2, outbox: 5 });
  }, 30_000);

  it('returns 409 when the same idempotency key is reused with a different payload', async () => {
    const walletId = await createWallet('100.00');
    const first = await submit(wagerRequest(walletId, 'same-key-conflict', '10.00'));
    const second = await submit(wagerRequest(walletId, 'same-key-conflict', '11.00'));
    const conflictBody: unknown = await second.json();

    expect(first.status).toBe(200);
    expect(second.status).toBe(409);
    expect(isJsonObject(conflictBody) ? conflictBody['code'] : undefined).toBe('WAGER_IDEMPOTENCY_CONFLICT');
    expect(await readBalance(walletId)).toBe('90.00');
  });

  it('credits WIN and records LOSS without moving the balance or creating a ledger entry', async () => {
    const walletId = await createWallet('10.00');
    const win = await submit(wagerRequest(walletId, 'win-credit', '5.00', 'WIN'));
    const loss = await submit(wagerRequest(walletId, 'loss-no-movement', '5.00', 'LOSS'));
    const winBody = await readWagerResponse(win);
    const lossBody = await readWagerResponse(loss);

    expect(winBody.balance.amount).toBe('15.00');
    expect(lossBody.balance.amount).toBe('15.00');
    expect(await readBalance(walletId)).toBe('15.00');
    expect(await financialCounts(walletId)).toEqual({ transactions: 3, ledger: 2, outbox: 5 });
  });

  it('queries wallet, transaction and stable ledger pages and reconciles without changing money', async () => {
    const walletId = await createWallet('100.00');
    const wager = await submit(wagerRequest(walletId, 'query-ledger-bet', '15.00'));
    const wagerBody = await readWagerResponse(wager);
    const wallet = await fetch(`${testBaseUrl}/wallets/${walletId}`);
    const firstLedgerPage = await fetch(`${testBaseUrl}/wallets/${walletId}/ledger?limit=1`);
    const firstPageBody: unknown = await firstLedgerPage.json();
    expect(isJsonObject(firstPageBody)).toBe(true);
    if (!isJsonObject(firstPageBody) || typeof firstPageBody['nextCursor'] !== 'string') {
      throw new Error(`Ledger first page did not include a cursor: ${firstLedgerPage.status} ${JSON.stringify(firstPageBody)}`);
    }
    const secondLedgerPage = await fetch(
      `${testBaseUrl}/wallets/${walletId}/ledger?limit=1&cursor=${encodeURIComponent(firstPageBody['nextCursor'])}`,
    );
    const byId = await fetch(`${testBaseUrl}/wagering/transactions/${wagerBody.transactionId}`);
    const byProvider = await fetch(
      `${testBaseUrl}/providers/${integrationProviderId}/wagering/transactions/query-ledger-bet`,
    );
    const reconciliation = await fetch(`${testBaseUrl}/wallets/${walletId}/reconciliation`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ walletId }),
    });

    expect(wallet.status).toBe(200);
    const walletBody = await readResponseObject(wallet);
    const walletBalance = readResponseObjectValue(walletBody, 'balance');
    expect(walletBalance['amount']).toBe('85.00');
    expect(firstLedgerPage.status).toBe(200);
    expect(secondLedgerPage.status).toBe(200);
    const firstPageEntries = firstPageBody['entries'];
    if (!Array.isArray(firstPageEntries)) throw new Error('Ledger first page entries are invalid');
    const secondPageBody = await readResponseObject(secondLedgerPage);
    const secondPageEntries = secondPageBody['entries'];
    if (!Array.isArray(secondPageEntries)) throw new Error('Ledger second page entries are invalid');
    expect(firstPageEntries).toHaveLength(1);
    expect(secondPageEntries).toHaveLength(1);
    expect(byId.status).toBe(200);
    expect(byProvider.status).toBe(200);
    const transactionBody = await readResponseObject(byId);
    const transactionBalance = readResponseObjectValue(transactionBody, 'balance');
    expect(transactionBalance['amount']).toBe('85.00');
    expect(reconciliation.status).toBe(200);
    expect(await reconciliation.json()).toMatchObject({
      walletId,
      storedBalance: { amount: '85.00', currency: 'BRL' },
      calculatedBalance: { amount: '85.00', currency: 'BRL' },
      difference: { amount: '0.00', currency: 'BRL' },
      consistent: true,
      checkedEntries: 2,
    });
  });

  it('reconciles without a body when accumulated credits exceed an individual monetary amount', async () => {
    const walletId = await createWallet('9999999999999999.99');
    expect((await submit(wagerRequest(walletId, 'large-turnover-bet', '1.00'))).status).toBe(200);
    expect((await submit(wagerRequest(walletId, 'large-turnover-win', '1.00', 'WIN'))).status).toBe(200);
    const response = await fetch(`${testBaseUrl}/wallets/${walletId}/reconciliation`, { method: 'POST' });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      consistent: true, calculatedBalance: { amount: '9999999999999999.99', currency: 'BRL' },
      difference: { amount: '0.00', currency: 'BRL' }, checkedEntries: 3,
    });
  });

  it('signals reconciliation divergence without repairing the stored balance', async () => {
    const walletId = await createWallet('100.00');
    await testOrm.em.getConnection().execute('UPDATE wallets SET balance = ? WHERE id = ?', ['99.00', walletId]);
    try {
      const response = await fetch(`${testBaseUrl}/wallets/${walletId}/reconciliation`, { method: 'POST' });
      const body: unknown = await response.json();
      expect(response.status).toBe(200);
      expect(isJsonObject(body) ? body['consistent'] : undefined).toBe(false);
      expect(isJsonObject(body) ? body['difference'] : undefined).toEqual({ amount: '-1.00', currency: 'BRL' });
      expect(await readBalance(walletId, false)).toBe('99.00');
      expect(await testApp.get(MetricsService).metrics()).toContain('wallet_reconciliation_divergences_total 1');
    } finally {
      // Restore only the deliberately corrupted fixture after proving the API did not repair it.
      await testOrm.em.getConnection().execute('UPDATE wallets SET balance = ? WHERE id = ?', ['100.00', walletId]);
    }
    expect(await readBalance(walletId)).toBe('100.00');
  });

  it('refunds a processed bet once and replays the original financial result', async () => {
    const walletId = await createWallet('100.00');
    await submit(wagerRequest(walletId, 'refund-target', '25.00'));

    const refundRequest = wagerRequest(walletId, 'refund-once', '25.00', 'REFUND', 'refund-target');
    const refund = await submit(refundRequest);
    const replay = await submit(refundRequest);
    const duplicateRefund = await submit(
      wagerRequest(walletId, 'refund-twice', '25.00', 'REFUND', 'refund-target'),
    );
    const refundBody = await readWagerResponse(refund);
    const replayBody = await readWagerResponse(replay);
    const duplicateBody = await readWagerResponse(duplicateRefund);

    expect(refund.status).toBe(200);
    expect(refundBody.balance.amount).toBe('100.00');
    expect(replayBody.idempotentReplay).toBe(true);
    expect(replayBody.balance.amount).toBe('100.00');
    expect(duplicateRefund.status).toBe(422);
    expect(duplicateBody.failureCode).toBe('WAGER_ALREADY_REVERSED');
    expect(await readBalance(walletId)).toBe('100.00');
    expect(await financialCounts(walletId)).toEqual({ transactions: 4, ledger: 3, outbox: 7 });
  });

  it('rolls back a credit with an equal debit once and rejects duplicate reversals', async () => {
    const walletId = await createWallet('10.00');
    await submit(wagerRequest(walletId, 'rollback-win-target', '10.00', 'WIN'));
    const rollback = await submit(wagerRequest(walletId, 'rollback-win-once', '10.00', 'ROLLBACK', 'rollback-win-target'));
    const duplicate = await submit(wagerRequest(walletId, 'rollback-win-twice', '10.00', 'ROLLBACK', 'rollback-win-target'));
    const rollbackBody = await readWagerResponse(rollback);
    const duplicateBody = await readWagerResponse(duplicate);

    expect(rollback.status).toBe(200);
    expect(rollbackBody.balance.amount).toBe('10.00');
    expect(duplicate.status).toBe(422);
    expect(duplicateBody.failureCode).toBe('WAGER_ALREADY_REVERSED');
    expect(await readBalance(walletId)).toBe('10.00');
    expect(await financialCounts(walletId)).toEqual({ transactions: 4, ledger: 3, outbox: 7 });
  });

  it('rejects a rollback that would overdraw with its distinct failure code', async () => {
    const walletId = await createWallet('10.00');
    await submit(wagerRequest(walletId, 'rollback-insufficient-win', '10.00', 'WIN'));
    await submit(wagerRequest(walletId, 'rollback-insufficient-spend', '20.00'));
    const response = await submit(
      wagerRequest(walletId, 'rollback-insufficient', '10.00', 'ROLLBACK', 'rollback-insufficient-win'),
    );
    const body = await readWagerResponse(response);

    expect(response.status).toBe(422);
    expect(body.failureCode).toBe('REVERSAL_INSUFFICIENT_FUNDS');
    expect(await readBalance(walletId)).toBe('0.00');
    expect(await financialCounts(walletId)).toEqual({ transactions: 4, ledger: 3, outbox: 7 });
  });

  it('accepts a reversal before its reference and processes it after the reference arrives', async () => {
    const walletId = await createWallet('100.00');
    const pendingResponse = await submit(
      wagerRequest(walletId, 'pending-refund', '25.00', 'REFUND', 'late-bet'),
    );
    const pendingBody = await readWagerResponse(pendingResponse);

    expect(pendingResponse.status).toBe(202);
    expect(pendingBody.status).toBe('PENDING_REFERENCE');
    expect(await readBalance(walletId)).toBe('100.00');

    const referenceResponse = await submit(wagerRequest(walletId, 'late-bet', '25.00'));
    const referenceBody = await readWagerResponse(referenceResponse);
    const processPendingReferences = testApp.get(ProcessPendingWagerReferencesUseCase);
    const recoveryDeadline = Date.now() + 5_000;
    while (Date.now() < recoveryDeadline) {
      await processPendingReferences.execute();
      const rows = await testOrm.em.getConnection().execute<Array<{ status: string }>>(
        'SELECT status FROM wager_transactions WHERE id = ?',
        [pendingBody.transactionId],
      );
      if (rows[0]?.status === 'PROCESSED') break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    const rows = await testOrm.em.getConnection().execute<Array<{
      status: string;
      reference_transaction_id: string;
      failure_code: string | null;
    }>>(
      'SELECT status, reference_transaction_id, failure_code FROM wager_transactions WHERE id = ?',
      [pendingBody.transactionId],
    );
    expect(rows[0]).toEqual({
      status: 'PROCESSED',
      reference_transaction_id: referenceBody.transactionId,
      failure_code: null,
    });
    expect(await readBalance(walletId)).toBe('100.00');
    expect(await financialCounts(walletId)).toEqual({ transactions: 3, ledger: 3, outbox: 7 });
  });

  it('rejects an unresolved reference after five durable attempts and records its event', async () => {
    const walletId = await createWallet('100.00');
    const response = await submit(wagerRequest(walletId, 'pending-expired-refund', '25.00', 'REFUND', 'never-arrived'));
    const body = await readWagerResponse(response);
    expect(response.status).toBe(202);

    const processPendingReferences = testApp.get(ProcessPendingWagerReferencesUseCase);
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await testOrm.em.getConnection().execute(
        "UPDATE wager_transactions SET reference_next_attempt_at = current_timestamp WHERE id = ? AND status = 'PENDING_REFERENCE'",
        [body.transactionId],
      );
      await processPendingReferences.execute();
    }

    const rows = await testOrm.em.getConnection().execute<Array<{ status: string; failure_code: string | null; attempts: number }>>(
      'SELECT status, failure_code, reference_attempts AS attempts FROM wager_transactions WHERE id = ?',
      [body.transactionId],
    );
    const events = await testOrm.em.getConnection().execute<Array<{ event_type: string; failure_code: string }>>(
      `SELECT event_type, payload->'data'->>'failureCode' AS failure_code FROM outbox_messages
       WHERE aggregate_id = ? AND payload->'data'->>'transactionId' = ? ORDER BY occurred_at, id`,
      [walletId, body.transactionId],
    );
    expect(rows[0]).toEqual({ status: 'REJECTED', failure_code: 'WAGER_REFERENCE_NOT_FOUND', attempts: 5 });
    expect(events.at(-1)).toEqual({ event_type: 'WagerTransactionRejected', failure_code: 'WAGER_REFERENCE_NOT_FOUND' });
    expect(await readBalance(walletId)).toBe('100.00');
  });

  it('commits the SQS inbox reservation atomically and suppresses redelivery', async () => {
    const walletId = await createWallet('100.00');
    const request = wagerRequest(walletId, 'inbox-redelivery', '10.00');
    const useCase = testApp.get(ProcessWagerUseCase);
    const playerId = walletPlayerIds.get(walletId);
    if (playerId === undefined) throw new Error('Wallet player ID is missing');
    const input = {
      providerId: request.body.providerId,
      externalTransactionId: request.body.externalTransactionId,
      idempotencyKey: request.key,
      playerId,
      walletId,
      roundId: request.body.roundId,
      gameId: request.body.gameId,
      kind: request.body.kind,
      money: Money.from(request.body.money),
    };
    const ingress = {
      consumerName: `wager-transactions-${integrationRunId}`,
      messageId: `sqs-message-${integrationRunId}`,
    };

    const first = await useCase.execute(input, ingress);
    const replay = await useCase.execute(input, ingress);
    expect(first.idempotentReplay).toBe(false);
    expect(replay.idempotentReplay).toBe(true);
    const changedTransportKey = await useCase.execute({ ...input, idempotencyKey: `${request.key}-changed` }, ingress);
    expect(changedTransportKey).toEqual(replay);

    const rows = await testOrm.em.getConnection().execute<Array<{ inbox: number; ledger: number }>>(
      `SELECT
         (SELECT count(*)::int FROM inbox_messages WHERE consumer_name = ? AND message_id = ?) AS inbox,
         (SELECT count(*)::int FROM wallet_ledger_entries WHERE wallet_id = ?) AS ledger`,
      [ingress.consumerName, ingress.messageId, walletId],
    );
    expect(rows[0]).toEqual({ inbox: 1, ledger: 2 });
    expect(await readBalance(walletId)).toBe('90.00');
  });

  it('normalizes UUID case before wallet ownership checks and idempotency hashing', async () => {
    const playerId = crypto.randomUUID();
    const created = await fetch(`${testBaseUrl}/wallets`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ playerId: playerId.toUpperCase(), initialBalance: { amount: '100.00', currency: 'BRL' } }),
    });
    const wallet = await readResponseObject(created);
    if (typeof wallet['id'] !== 'string') throw new Error('Missing wallet ID');
    walletPlayerIds.set(wallet['id'], playerId);
    const request = wagerRequest(wallet['id'], 'uuid-case', '10.00');
    const first = await fetch(`${testBaseUrl}/wagering/transactions`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': request.key },
      body: JSON.stringify({ ...request.body, playerId: playerId.toUpperCase(), walletId: wallet['id'].toUpperCase() }),
    });
    expect(first.status).toBe(200);
    const replay = await submit(request);
    expect(replay.status).toBe(200);
    expect(await readWagerResponse(replay)).toMatchObject({ idempotentReplay: true, balance: { amount: '90.00' } });
    expect(await readBalance(wallet['id'])).toBe('90.00');
  });

  it('rolls back the inbox, wager, ledger and balance together when outbox persistence fails', async () => {
    const walletId = await createWallet('100.00');
    const request = wagerRequest(walletId, 'atomic-outbox-failure', '10.00');
    const playerId = walletPlayerIds.get(walletId);
    if (playerId === undefined) throw new Error('Wallet player ID is missing');
    const useCase = testApp.get(ProcessWagerUseCase);
    const triggerName = `test_reject_wager_outbox_${integrationRunId.replaceAll('-', '')}`;
    await testOrm.em.getConnection().execute(
      `CREATE FUNCTION ${triggerName}() RETURNS trigger AS $$
       BEGIN
         IF NEW.payload->'data'->>'externalTransactionId' = TG_ARGV[0] THEN
           RAISE EXCEPTION 'forced outbox permission failure' USING ERRCODE = '42501';
         END IF;
         RETURN NEW;
       END; $$ LANGUAGE plpgsql`,
    );
    await testOrm.em.getConnection().execute(
      `CREATE TRIGGER ${triggerName} BEFORE INSERT ON outbox_messages
       FOR EACH ROW EXECUTE FUNCTION ${triggerName}('${request.body.externalTransactionId}')`,
    );
    try {
      const failed = await useCase.execute({
        providerId: request.body.providerId,
        externalTransactionId: request.body.externalTransactionId,
        idempotencyKey: request.key,
        playerId,
        walletId,
        roundId: request.body.roundId,
        gameId: request.body.gameId,
        kind: request.body.kind,
        money: Money.from(request.body.money),
      }, { consumerName: `atomic-${integrationRunId}`, messageId: `atomic-${integrationRunId}` });
      expect(failed.status).toBe('FAILED');
      expect(failed.failureCode).toBe('PERMANENT_INFRASTRUCTURE_FAILURE');
      const replay = await submit(request);
      expect(replay.status).toBe(500);
      const replayBody: unknown = await replay.json();
      expect(isJsonObject(replayBody) ? replayBody['idempotentReplay'] : undefined).toBe(true);
    } finally {
      await testOrm.em.getConnection().execute(`DROP TRIGGER ${triggerName} ON outbox_messages`);
      await testOrm.em.getConnection().execute(`DROP FUNCTION ${triggerName}()`);
    }

    const rows = await testOrm.em.getConnection().execute<Array<{
      inbox: number; wagers: number; wager_status: string; failure_code: string | null; ledger: number; outbox: number;
    }>>(
      `SELECT
         (SELECT count(*)::int FROM inbox_messages WHERE consumer_name = ? AND message_id = ?) AS inbox,
         (SELECT count(*)::int FROM wager_transactions WHERE provider_id = ? AND external_transaction_id = ?) AS wagers,
         (SELECT status FROM wager_transactions WHERE provider_id = ? AND external_transaction_id = ?) AS wager_status,
         (SELECT failure_code FROM wager_transactions WHERE provider_id = ? AND external_transaction_id = ?) AS failure_code,
         (SELECT count(*)::int FROM wallet_ledger_entries WHERE wallet_id = ?) AS ledger,
         (SELECT count(*)::int FROM outbox_messages WHERE aggregate_id = ?) AS outbox`,
      [`atomic-${integrationRunId}`, `atomic-${integrationRunId}`, request.body.providerId,
        request.body.externalTransactionId, request.body.providerId, request.body.externalTransactionId,
        request.body.providerId, request.body.externalTransactionId, walletId, walletId],
    );
    expect(rows[0]).toEqual({
      inbox: 0,
      wagers: 1,
      wager_status: 'FAILED',
      failure_code: 'PERMANENT_INFRASTRUCTURE_FAILURE',
      ledger: 1,
      outbox: 2,
    });
    expect(await readBalance(walletId)).toBe('100.00');
  });

  it('does not make an unclassified database error terminal and allows retry after recovery', async () => {
    const walletId = await createWallet('100.00');
    const request = wagerRequest(walletId, 'unclassified-outbox-error', '10.00');
    const triggerName = `test_unknown_outbox_${integrationRunId.replaceAll('-', '')}`;
    const connection = testOrm.em.getConnection();
    await connection.execute(
      `CREATE FUNCTION ${triggerName}() RETURNS trigger AS $$
       BEGIN
         IF NEW.payload->'data'->>'externalTransactionId' = TG_ARGV[0] THEN
           RAISE EXCEPTION 'unclassified server failure';
         END IF;
         RETURN NEW;
       END; $$ LANGUAGE plpgsql`,
    );
    await connection.execute(
      `CREATE TRIGGER ${triggerName} BEFORE INSERT ON outbox_messages
       FOR EACH ROW EXECUTE FUNCTION ${triggerName}('unclassified-outbox-error')`,
    );
    try {
      const response = await submit(request);
      expect(response.status).toBe(500);
      expect(await response.json()).toMatchObject({ code: 'INTERNAL_SERVER_ERROR', message: 'Internal server error' });
      expect(await financialCounts(walletId)).toEqual({ transactions: 1, ledger: 1, outbox: 2 });
      expect(await readBalance(walletId)).toBe('100.00');
    } finally {
      await connection.execute(`DROP TRIGGER ${triggerName} ON outbox_messages`);
      await connection.execute(`DROP FUNCTION ${triggerName}()`);
    }
    const recovered = await submit(request);
    expect(recovered.status).toBe(200);
    expect(await readWagerResponse(recovered)).toMatchObject({ status: 'PROCESSED', idempotentReplay: false });
    expect(await readBalance(walletId)).toBe('90.00');
  });
});

interface WagerResponse {
  transactionId: string;
  status: 'PROCESSED' | 'REJECTED' | 'PENDING_REFERENCE' | 'FAILED';
  balance: { amount: string; currency: string };
  idempotentReplay: boolean;
  failureCode?: string;
}

function wagerRequest(
  walletId: string,
  key: string,
  amount: string,
  kind: 'BET' | 'WIN' | 'LOSS' | 'REFUND' | 'ROLLBACK' = 'BET',
  referenceExternalTransactionId?: string,
) {
  return {
    key,
    body: {
      providerId: integrationProviderId,
      externalTransactionId: key,
      playerId: walletPlayerIds.get(walletId),
      walletId,
      roundId: 'integration-round',
      gameId: 'integration-game',
      kind,
      money: { amount, currency: 'BRL' },
      ...(referenceExternalTransactionId === undefined ? {} : { referenceExternalTransactionId }),
    },
  };
}

const walletPlayerIds = new Map<string, string>();

async function createWallet(amount: string): Promise<string> {
  const playerId = crypto.randomUUID();
  const response = await fetch(`${testBaseUrl}/wallets`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ playerId, initialBalance: { amount, currency: 'BRL' } }),
  });
  const body: unknown = await response.json();
  if (!isJsonObject(body) || typeof body['id'] !== 'string') {
    throw new Error('Wallet creation response did not include an ID');
  }
  walletPlayerIds.set(body['id'], playerId);
  return body['id'];
}

function submit(request: ReturnType<typeof wagerRequest>): Promise<Response> {
  return fetch(`${testBaseUrl}/wagering/transactions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': request.key },
    body: JSON.stringify(request.body),
  });
}

async function financialCounts(walletId: string): Promise<{ transactions: number; ledger: number; outbox: number }> {
  const rows = await testOrm.em.getConnection().execute<
    { transactions: number; ledger: number; outbox: number }[]
  >(
    `SELECT
       (SELECT count(*)::int FROM wager_transactions WHERE wallet_id = ?) AS transactions,
       (SELECT count(*)::int FROM wallet_ledger_entries WHERE wallet_id = ?) AS ledger,
       (SELECT count(*)::int FROM outbox_messages WHERE aggregate_id = ?) AS outbox`,
    [walletId, walletId, walletId],
  );
  return rows[0];
}

async function readBalance(walletId: string, checkLedger = true): Promise<string> {
  const rows = await testOrm.em.getConnection().execute<Array<{ balance: string; ledger_balance: string }>>(
    `SELECT w.balance, ROUND(COALESCE(SUM(CASE WHEN e.direction = 'CREDIT' THEN e.amount ELSE -e.amount END), 0), 2)::text AS ledger_balance
     FROM wallets w LEFT JOIN wallet_ledger_entries e ON e.wallet_id = w.id WHERE w.id = ? GROUP BY w.id`,
    [walletId],
  );
  if (checkLedger) expect(rows[0].balance).toBe(rows[0].ledger_balance);
  return rows[0].balance;
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function readWagerResponse(response: Response): Promise<WagerResponse> {
  const body: unknown = await response.json();
  if (
    !isJsonObject(body) ||
    typeof body['transactionId'] !== 'string' ||
    !isWagerStatus(body['status']) ||
    !isJsonObject(body['balance']) ||
    typeof body['balance']['amount'] !== 'string' ||
    typeof body['balance']['currency'] !== 'string' ||
    typeof body['idempotentReplay'] !== 'boolean' ||
    (body['failureCode'] !== undefined && typeof body['failureCode'] !== 'string')
  ) {
    throw new Error('Wager response did not match its contract');
  }
  return {
    transactionId: body['transactionId'],
    status: body['status'],
    balance: { amount: body['balance']['amount'], currency: body['balance']['currency'] },
    idempotentReplay: body['idempotentReplay'],
    ...(typeof body['failureCode'] === 'string' ? { failureCode: body['failureCode'] } : {}),
  };
}

async function readResponseObject(response: Response): Promise<Record<string, unknown>> {
  const body: unknown = await response.json();
  if (!isJsonObject(body)) throw new Error('Response did not contain a JSON object');
  return body;
}

function readResponseObjectValue(body: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = body[key];
  if (!isJsonObject(value)) throw new Error(`Response field ${key} did not contain an object`);
  return value;
}

function isWagerStatus(value: unknown): value is WagerResponse['status'] {
  return value === 'PROCESSED' || value === 'REJECTED' || value === 'PENDING_REFERENCE' || value === 'FAILED';
}
