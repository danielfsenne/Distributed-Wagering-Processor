import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { newId } from '../../src/domain/shared/id';
import { type TestHttpApp, startTestHttpApp } from '../support/app';
import { assertLedgerMatchesBalance, countRows, keyFor, wagerBody } from '../support/fixtures';

type WalletView = { balance: { amount: string; currency: string }; version: number };

let http: TestHttpApp;

beforeAll(async () => {
  http = await startTestHttpApp();
});

afterAll(async () => {
  await http.close();
});

async function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  const response = await fetch(`${http.baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Record<string, any> };
}

async function openWallet(amount: string) {
  const response = await post('/wallets', { playerId: newId(), initialBalance: { amount, currency: 'BRL' } });
  expect(response.status).toBe(201);
  return response.body as { id: string; playerId: string };
}

function submit(body: ReturnType<typeof wagerBody>, key = keyFor(body)) {
  return post('/wagering/transactions', body, { 'Idempotency-Key': key });
}

async function debitEntries(walletId: string) {
  return countRows(
    http.container.orm,
    `SELECT COUNT(*) AS count FROM wallet_ledger_entries WHERE wallet_id = ? AND direction = 'DEBIT'`,
    [walletId],
  );
}

describe('concurrency on a single wallet', () => {
  it('mandatory scenario: two simultaneous 80.00 bets on 100.00 leave exactly one debit', async () => {
    const wallet = await openWallet('100.00');
    const first = wagerBody(wallet, 'BET', '80.00');
    const second = wagerBody(wallet, 'BET', '80.00');

    const responses = await Promise.all([submit(first), submit(second)]);
    const statuses = responses.map((response) => response.body.status).sort();
    expect(statuses).toEqual(['PROCESSED', 'REJECTED']);
    const rejected = responses.find((response) => response.body.status === 'REJECTED')!;
    expect(rejected.status).toBe(422);
    expect(rejected.body.failureCode).toBe('INSUFFICIENT_FUNDS');

    const retries = await Promise.all([submit(first), submit(second), submit(first), submit(second)]);
    expect(retries.every((response) => response.body.idempotentReplay === true)).toBe(true);

    const wallet2 = (await fetch(`${http.baseUrl}/wallets/${wallet.id}`).then((response) => response.json())) as WalletView;
    expect(wallet2.balance).toEqual({ amount: '20.00', currency: 'BRL' });
    expect(await debitEntries(wallet.id)).toBe(1);
    await assertLedgerMatchesBalance(http.container.orm, wallet.id);
  });

  it('the same bet sent 50 times in parallel debits exactly once', async () => {
    const wallet = await openWallet('1000.00');
    const body = wagerBody(wallet, 'BET', '25.00');

    const responses = await Promise.all(Array.from({ length: 50 }, () => submit(body)));
    const created = responses.filter((response) => response.status === 201);
    const replays = responses.filter((response) => response.status === 200);
    expect(created).toHaveLength(1);
    expect(replays).toHaveLength(49);
    expect(new Set(responses.map((response) => response.body.transactionId)).size).toBe(1);
    expect(responses.every((response) => response.body.balance.amount === '975.00')).toBe(true);

    expect(await debitEntries(wallet.id)).toBe(1);
    await assertLedgerMatchesBalance(http.container.orm, wallet.id);
  });

  it('many different bets competing for the same balance never overdraw', async () => {
    const wallet = await openWallet('50.00');
    const bodies = Array.from({ length: 80 }, () => wagerBody(wallet, 'BET', '1.00'));

    const responses = await Promise.all(bodies.map((body) => submit(body)));
    const processed = responses.filter((response) => response.body.status === 'PROCESSED');
    const rejected = responses.filter((response) => response.body.status === 'REJECTED');
    expect(processed).toHaveLength(50);
    expect(rejected).toHaveLength(30);
    expect(rejected.every((response) => response.body.failureCode === 'INSUFFICIENT_FUNDS')).toBe(true);

    const balances = processed.map((response) => response.body.balance.amount).sort();
    expect(new Set(balances).size).toBe(50);
    expect(await debitEntries(wallet.id)).toBe(50);
    await assertLedgerMatchesBalance(http.container.orm, wallet.id);
  });

  it('concurrent mixed operations keep balance equal to the ledger', async () => {
    const wallet = await openWallet('100.00');
    const bets = Array.from({ length: 20 }, () => wagerBody(wallet, 'BET', '5.00'));
    await Promise.all(bets.map((body) => submit(body)));

    const operations = bets.flatMap((bet, index) => {
      const win = wagerBody(wallet, 'WIN', '7.50', { referenceExternalTransactionId: bet.externalTransactionId });
      const refund = wagerBody(wallet, 'REFUND', '5.00', { referenceExternalTransactionId: bet.externalTransactionId });
      const rollback = wagerBody(wallet, 'ROLLBACK', '5.00', { referenceExternalTransactionId: bet.externalTransactionId });
      return index % 2 === 0 ? [win, refund, rollback] : [refund, rollback, refund];
    });
    const responses = await Promise.all(operations.map((body) => submit(body)));
    const statuses = new Set(responses.map((response) => response.status));
    expect([...statuses].every((status) => [200, 201, 422].includes(status))).toBe(true);

    const reversals = await countRows(
      http.container.orm,
      `SELECT COUNT(*) AS count FROM wager_transactions
        WHERE wallet_id = ? AND kind IN ('REFUND', 'ROLLBACK') AND status = 'PROCESSED'`,
      [wallet.id],
    );
    expect(reversals).toBe(20);
    expect(responses.filter((response) => response.status === 200)).toHaveLength(10);
    await assertLedgerMatchesBalance(http.container.orm, wallet.id);
  });
});

describe('concurrency across wallets', () => {
  it('processes different wallets in parallel without interference', async () => {
    const wallets = await Promise.all(Array.from({ length: 20 }, () => openWallet('100.00')));
    const bodies = wallets.flatMap((wallet) => Array.from({ length: 10 }, () => wagerBody(wallet, 'BET', '3.00')));

    const responses = await Promise.all(bodies.map((body) => submit(body)));
    expect(responses.every((response) => response.status === 201)).toBe(true);

    for (const wallet of wallets) {
      const view = (await fetch(`${http.baseUrl}/wallets/${wallet.id}`).then((response) => response.json())) as WalletView;
      expect(view.balance.amount).toBe('70.00');
      expect(view.version).toBe(11);
      await assertLedgerMatchesBalance(http.container.orm, wallet.id);
    }
  });

  it('a locked hot wallet does not block other wallets (no global lock)', async () => {
    const hot = await openWallet('100.00');
    const cold = await openWallet('100.00');

    let releaseLock: () => void = () => {};
    const lockReleased = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    let lockAcquired: () => void = () => {};
    const acquired = new Promise<void>((resolve) => {
      lockAcquired = resolve;
    });
    const holder = http.container.orm.em.fork().transactional(async (em) => {
      await em.execute('SELECT id FROM wallets WHERE id = ? FOR UPDATE', [hot.id]);
      lockAcquired();
      await lockReleased;
    });
    await acquired;

    const hotStartedAt = performance.now();
    const hotRequest = submit(wagerBody(hot, 'BET', '1.00'));
    const coldStartedAt = performance.now();
    const coldResponse = await submit(wagerBody(cold, 'BET', '1.00'));
    const coldElapsed = performance.now() - coldStartedAt;

    expect(coldResponse.status).toBe(201);
    expect(coldElapsed).toBeLessThan(1_000);

    await Bun.sleep(300);
    releaseLock();
    await holder;
    const hotResponse = await hotRequest;
    expect(hotResponse.status).toBe(201);
    expect(performance.now() - hotStartedAt).toBeGreaterThanOrEqual(300);
  });
});
