import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { newId } from '../../src/domain/shared/id';
import { type TestHttpApp, startTestHttpApp } from '../support/app';
import { type WagerBody, assertLedgerMatchesBalance, keyFor, wagerBody } from '../support/fixtures';

let http: TestHttpApp;

beforeAll(async () => {
  http = await startTestHttpApp();
});

afterAll(async () => {
  await http.close();
});

async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const response = await fetch(`${http.baseUrl}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
  const text = await response.text();
  return {
    status: response.status,
    headers: response.headers,
    body: text && response.headers.get('content-type')?.includes('json') ? JSON.parse(text) : text,
  };
}

async function openWallet(amount = '100.00') {
  const playerId = newId();
  const response = await call('POST', '/wallets', {
    playerId,
    initialBalance: { amount, currency: 'BRL' },
  });
  expect(response.status).toBe(201);
  return response.body as { id: string; playerId: string; balance: { amount: string; currency: string }; version: number };
}

function submit(body: WagerBody | unknown, key?: string) {
  const headers: Record<string, string> = {};
  if (key !== undefined) headers['Idempotency-Key'] = key;
  return call('POST', '/wagering/transactions', body, headers);
}

describe('HTTP API', () => {
  describe('wallets', () => {
    it('creates a wallet with an opening ledger entry', async () => {
      const wallet = await openWallet('1000.00');
      expect(wallet.balance).toEqual({ amount: '1000.00', currency: 'BRL' });
      expect(wallet.version).toBe(1);

      const ledger = await call('GET', `/wallets/${wallet.id}/ledger`);
      expect(ledger.status).toBe(200);
      expect(ledger.body.entries).toHaveLength(1);
      expect(ledger.body.entries[0].direction).toBe('CREDIT');
      await assertLedgerMatchesBalance(http.container.orm, wallet.id);
    });

    it('creates a zero balance wallet without ledger entries', async () => {
      const wallet = await openWallet('0.00');
      const ledger = await call('GET', `/wallets/${wallet.id}/ledger`);
      expect(ledger.body.entries).toHaveLength(0);
    });

    it('rejects a duplicate wallet for the same player and currency as conflict', async () => {
      const wallet = await openWallet('10.00');
      const duplicate = await call('POST', '/wallets', {
        playerId: wallet.playerId,
        initialBalance: { amount: '5.00', currency: 'BRL' },
      });
      expect(duplicate.status).toBe(409);
      expect(duplicate.body.error.code).toBe('WALLET_ALREADY_EXISTS');

      const otherCurrency = await call('POST', '/wallets', {
        playerId: wallet.playerId,
        initialBalance: { amount: '5.00', currency: 'USD' },
      });
      expect(otherCurrency.status).toBe(201);
    });

    it.each([
      [{ playerId: 'not-a-uuid', initialBalance: { amount: '1.00', currency: 'BRL' } }],
      [{ playerId: newId(), initialBalance: { amount: 1, currency: 'BRL' } }],
      [{ playerId: newId(), initialBalance: { amount: '-1.00', currency: 'BRL' } }],
      [{ playerId: newId(), initialBalance: { amount: '1.001', currency: 'BRL' } }],
    ])('rejects invalid wallet payloads with 400', async (payload) => {
      const response = await call('POST', '/wallets', payload);
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('INVALID_PAYLOAD');
    });

    it('returns 404 for unknown wallets and 400 for malformed ids', async () => {
      expect((await call('GET', `/wallets/${newId()}`)).status).toBe(404);
      expect((await call('GET', '/wallets/abc')).status).toBe(400);
    });

    it('paginates the ledger with a stable opaque cursor', async () => {
      const wallet = await openWallet('100.00');
      for (let i = 0; i < 4; i++) {
        const body = wagerBody(wallet, 'BET', '1.00');
        expect((await submit(body, keyFor(body))).status).toBe(201);
      }
      const seen: string[] = [];
      let cursor: string | null = null;
      do {
        const query: string = cursor ? `?limit=2&cursor=${cursor}` : '?limit=2';
        const page = await call('GET', `/wallets/${wallet.id}/ledger${query}`);
        expect(page.status).toBe(200);
        seen.push(...page.body.entries.map((entry: { id: string }) => entry.id));
        cursor = page.body.nextCursor;
      } while (cursor);
      expect(seen).toHaveLength(5);
      expect(new Set(seen).size).toBe(5);

      expect((await call('GET', `/wallets/${wallet.id}/ledger?cursor=garbage`)).status).toBe(400);
      expect((await call('GET', `/wallets/${wallet.id}/ledger?limit=0`)).status).toBe(400);
    });

    it('reconciles stored balance against the ledger', async () => {
      const wallet = await openWallet('100.00');
      const body = wagerBody(wallet, 'BET', '25.00');
      await submit(body, keyFor(body));
      const response = await call('POST', `/wallets/${wallet.id}/reconciliation`);
      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        walletId: wallet.id,
        storedBalance: { amount: '75.00', currency: 'BRL' },
        calculatedBalance: { amount: '75.00', currency: 'BRL' },
        difference: { amount: '0.00', currency: 'BRL' },
        consistent: true,
        checkedEntries: 2,
      });
    });
  });

  describe('wager transactions', () => {
    it('processes a BET and replays it idempotently', async () => {
      const wallet = await openWallet('1000.00');
      const body = wagerBody(wallet, 'BET', '25.00');

      const first = await submit(body, keyFor(body));
      expect(first.status).toBe(201);
      expect(first.body).toMatchObject({
        status: 'PROCESSED',
        balance: { amount: '975.00', currency: 'BRL' },
        idempotentReplay: false,
      });

      const replay = await submit({ ...body, money: { currency: 'BRL', amount: '25.00' } }, keyFor(body));
      expect(replay.status).toBe(200);
      expect(replay.body).toEqual({ ...first.body, idempotentReplay: true });
      await assertLedgerMatchesBalance(http.container.orm, wallet.id);
    });

    it('returns the balance observed at the time on replay', async () => {
      const wallet = await openWallet('100.00');
      const first = wagerBody(wallet, 'BET', '10.00');
      await submit(first, keyFor(first));
      const second = wagerBody(wallet, 'BET', '30.00');
      await submit(second, keyFor(second));

      const replay = await submit(first, keyFor(first));
      expect(replay.body.balance.amount).toBe('90.00');
    });

    it('treats the same key with a different payload as conflict', async () => {
      const wallet = await openWallet('100.00');
      const body = wagerBody(wallet, 'BET', '10.00');
      await submit(body, keyFor(body));

      const conflict = await submit({ ...body, money: { amount: '11.00', currency: 'BRL' } }, keyFor(body));
      expect(conflict.status).toBe(409);
      expect(conflict.body.error.code).toBe('IDEMPOTENCY_KEY_CONFLICT');
      expect(conflict.body.error.retryable).toBe(false);
    });

    it('treats the same external id under another key as conflict', async () => {
      const wallet = await openWallet('100.00');
      const body = wagerBody(wallet, 'BET', '10.00');
      await submit(body, keyFor(body));
      const conflict = await submit(body, 'another-key');
      expect(conflict.status).toBe(409);
      expect(conflict.body.error.code).toBe('EXTERNAL_TRANSACTION_CONFLICT');
    });

    it('rejects insufficient funds with 422 and a stable failure code', async () => {
      const wallet = await openWallet('10.00');
      const body = wagerBody(wallet, 'BET', '10.01');
      const response = await submit(body, keyFor(body));
      expect(response.status).toBe(422);
      expect(response.body).toMatchObject({
        status: 'REJECTED',
        failureCode: 'INSUFFICIENT_FUNDS',
        balance: { amount: '10.00', currency: 'BRL' },
      });
      const replay = await submit(body, keyFor(body));
      expect(replay.status).toBe(422);
      expect(replay.body.idempotentReplay).toBe(true);
      await assertLedgerMatchesBalance(http.container.orm, wallet.id);
    });

    it('requires the Idempotency-Key header', async () => {
      const wallet = await openWallet('10.00');
      const response = await submit(wagerBody(wallet, 'BET', '1.00'));
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('MISSING_IDEMPOTENCY_KEY');
    });

    it.each([
      ['OPENING kind', (body: WagerBody) => ({ ...body, kind: 'OPENING' })],
      ['unknown kind', (body: WagerBody) => ({ ...body, kind: 'JACKPOT' })],
      ['numeric amount', (body: WagerBody) => ({ ...body, money: { amount: 10, currency: 'BRL' } })],
      ['scientific notation', (body: WagerBody) => ({ ...body, money: { amount: '1e1', currency: 'BRL' } })],
      ['3 decimals', (body: WagerBody) => ({ ...body, money: { amount: '1.000', currency: 'BRL' } })],
      ['negative amount', (body: WagerBody) => ({ ...body, money: { amount: '-1.00', currency: 'BRL' } })],
      ['missing round', (body: WagerBody) => ({ ...body, roundId: undefined })],
      ['refund without reference', (body: WagerBody) => ({ ...body, kind: 'REFUND' })],
      ['zero bet', (body: WagerBody) => ({ ...body, money: { amount: '0.00', currency: 'BRL' } })],
    ])('rejects %s as invalid payload', async (_name, mutate) => {
      const wallet = await openWallet('10.00');
      const body = mutate(wagerBody(wallet, 'BET', '1.00'));
      const response = await submit(body, `k-${newId()}`);
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('INVALID_PAYLOAD');
    });

    it('rejects malformed JSON as invalid payload', async () => {
      const response = await submit('{"providerId":', 'malformed-json');
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('INVALID_PAYLOAD');
    });

    it('returns 404 for an unknown wallet', async () => {
      const body = wagerBody({ id: newId(), playerId: newId() }, 'BET', '1.00');
      const response = await submit(body, keyFor(body));
      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe('WALLET_NOT_FOUND');
    });

    it('rejects currency mismatch as business rejection', async () => {
      const wallet = await openWallet('10.00');
      const body = wagerBody(wallet, 'BET', '1.00', { money: { amount: '1.00', currency: 'USD' } });
      const response = await submit(body, keyFor(body));
      expect(response.status).toBe(422);
      expect(response.body.failureCode).toBe('CURRENCY_MISMATCH');
    });

    it('runs a full round: BET, WIN, ROLLBACK of WIN, LOSS', async () => {
      const wallet = await openWallet('100.00');
      const bet = wagerBody(wallet, 'BET', '20.00');
      const win = wagerBody(wallet, 'WIN', '50.00', { referenceExternalTransactionId: bet.externalTransactionId });
      const rollback = wagerBody(wallet, 'ROLLBACK', '50.00', {
        referenceExternalTransactionId: win.externalTransactionId,
      });
      const loss = wagerBody(wallet, 'LOSS', '0.00', { referenceExternalTransactionId: bet.externalTransactionId });

      expect((await submit(bet, keyFor(bet))).body.balance.amount).toBe('80.00');
      expect((await submit(win, keyFor(win))).body.balance.amount).toBe('130.00');
      expect((await submit(rollback, keyFor(rollback))).body.balance.amount).toBe('80.00');
      const lossResponse = await submit(loss, keyFor(loss));
      expect(lossResponse.status).toBe(201);
      expect(lossResponse.body.balance.amount).toBe('80.00');

      const ledger = await call('GET', `/wallets/${wallet.id}/ledger`);
      expect(ledger.body.entries).toHaveLength(4);
      await assertLedgerMatchesBalance(http.container.orm, wallet.id);
    });

    it('refunds a BET once and rejects a second reversal', async () => {
      const wallet = await openWallet('100.00');
      const bet = wagerBody(wallet, 'BET', '40.00');
      await submit(bet, keyFor(bet));
      const refund = wagerBody(wallet, 'REFUND', '40.00', { referenceExternalTransactionId: bet.externalTransactionId });
      const refundResponse = await submit(refund, keyFor(refund));
      expect(refundResponse.status).toBe(201);
      expect(refundResponse.body.balance.amount).toBe('100.00');

      const secondRefund = wagerBody(wallet, 'REFUND', '40.00', {
        referenceExternalTransactionId: bet.externalTransactionId,
      });
      const second = await submit(secondRefund, keyFor(secondRefund));
      expect(second.status).toBe(422);
      expect(second.body.failureCode).toBe('ALREADY_REVERSED');

      const rollback = wagerBody(wallet, 'ROLLBACK', '40.00', {
        referenceExternalTransactionId: bet.externalTransactionId,
      });
      expect((await submit(rollback, keyFor(rollback))).body.failureCode).toBe('ALREADY_REVERSED');
      await assertLedgerMatchesBalance(http.container.orm, wallet.id);
    });

    it('rejects a reversal that would make the balance negative with a distinct code', async () => {
      const wallet = await openWallet('0.00');
      const win = wagerBody(wallet, 'WIN', '30.00');
      await submit(win, keyFor(win));
      const bet = wagerBody(wallet, 'BET', '25.00');
      await submit(bet, keyFor(bet));
      const rollback = wagerBody(wallet, 'ROLLBACK', '30.00', { referenceExternalTransactionId: win.externalTransactionId });
      const response = await submit(rollback, keyFor(rollback));
      expect(response.status).toBe(422);
      expect(response.body.failureCode).toBe('REVERSAL_INSUFFICIENT_FUNDS');

      const stored = await call('GET', `/wagering/transactions/${response.body.transactionId}`);
      expect(stored.body.status).toBe('REJECTED');
      expect(stored.body.failureCode).toBe('REVERSAL_INSUFFICIENT_FUNDS');
    });

    it('accepts an out-of-order REFUND as PENDING_REFERENCE with 202', async () => {
      const wallet = await openWallet('100.00');
      const refund = wagerBody(wallet, 'REFUND', '10.00', { referenceExternalTransactionId: `late-${newId()}` });
      const response = await submit(refund, keyFor(refund));
      expect(response.status).toBe(202);
      expect(response.body.status).toBe('PENDING_REFERENCE');
      expect(response.body.balance.amount).toBe('100.00');
    });

    it('exposes transactions by id and by provider external id', async () => {
      const wallet = await openWallet('100.00');
      const body = wagerBody(wallet, 'BET', '10.00');
      const created = await submit(body, keyFor(body));

      const byId = await call('GET', `/wagering/transactions/${created.body.transactionId}`);
      expect(byId.status).toBe(200);
      expect(byId.body).toMatchObject({
        id: created.body.transactionId,
        status: 'PROCESSED',
        money: { amount: '10.00', currency: 'BRL' },
        resultBalance: { amount: '90.00', currency: 'BRL' },
      });

      const byExternal = await call(
        'GET',
        `/providers/${body.providerId}/wagering/transactions/${body.externalTransactionId}`,
      );
      expect(byExternal.body.id).toBe(created.body.transactionId);
      expect((await call('GET', `/providers/x/wagering/transactions/nope`)).status).toBe(404);
    });
  });

  describe('operational endpoints', () => {
    it('serves liveness and readiness without authentication', async () => {
      expect((await call('GET', '/health/live')).body).toEqual({ status: 'ok' });
      const ready = await call('GET', '/health/ready');
      expect(ready.status).toBe(200);
      expect(ready.body.checks).toEqual({ postgres: 'up', sqs: 'up' });
    });

    it('exposes Prometheus metrics', async () => {
      const response = await call('GET', '/metrics');
      expect(response.status).toBe(200);
      expect(response.body).toContain('wagering_transactions_total');
      expect(response.body).toContain('wagering_processing_duration_seconds');
    });

    it('propagates the correlation id', async () => {
      const response = await call('GET', '/health/live', undefined, { 'x-correlation-id': 'corr-123' });
      expect(response.headers.get('x-correlation-id')).toBe('corr-123');
    });
  });
});
