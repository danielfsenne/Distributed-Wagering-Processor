import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import type { Container } from '../../src/container';
import { newId } from '../../src/domain/shared/id';
import { Money } from '../../src/domain/shared/money';
import { createTestContainer } from '../support/app';
import { assertLedgerMatchesBalance, countRows, keyFor, wagerBody } from '../support/fixtures';
import { type AppProcess, spawnApp, stopAll } from '../support/processes';
import {
  type TestQueues,
  approximateCount,
  createTestQueues,
  receiveAll,
  sendWagerMessage,
  wagerMessage,
  waitFor,
} from '../support/queues';

let container: Container;
let processes: AppProcess[] = [];
let queues: TestQueues | undefined;

beforeAll(async () => {
  container = await createTestContainer();
});

afterEach(async () => {
  await stopAll(processes, 'SIGKILL');
  processes = [];
  await queues?.cleanup();
  queues = undefined;
});

afterAll(async () => {
  await container.close();
});

async function openWallet(amount: string) {
  return container.openWallet.execute({
    playerId: newId(),
    initialBalance: Money.from({ amount, currency: 'BRL' }),
    correlationId: newId(),
  });
}

function workerEnv(testQueues: TestQueues, consumerName: string): Record<string, string> {
  return {
    SQS_TRANSACTIONS_QUEUE: testQueues.main,
    SQS_DLQ_QUEUE: testQueues.deadLetter,
    SQS_EVENTS_QUEUE: testQueues.events,
    CONSUMER_NAME: consumerName,
    CONSUMER_VISIBILITY_TIMEOUT_SECONDS: '3',
    CONSUMER_RETRY_BASE_DELAY_SECONDS: '1',
  };
}

async function startWorkers(count: number, env: Record<string, string>, prefix = 'worker') {
  const started = await Promise.all(
    Array.from({ length: count }, (_, index) => spawnApp(`${prefix}-${index + 1}`, 'worker', env)),
  );
  processes.push(...started);
  return started;
}

async function assertExactlyOnce(walletIds: string[]) {
  for (const walletId of walletIds) {
    await assertLedgerMatchesBalance(container.orm, walletId);
  }
  const duplicates = await countRows(
    container.orm,
    `SELECT COUNT(*) AS count FROM (
       SELECT transaction_id FROM wallet_ledger_entries
        WHERE wallet_id = ANY(?::uuid[])
        GROUP BY transaction_id HAVING COUNT(*) > 1
     ) d`,
    [`{${walletIds.join(',')}}`],
  );
  expect(duplicates).toBe(0);
}

describe('three or more instances', () => {
  it('three API processes share a hot wallet without overdraft or duplicate debits', async () => {
    const apis = await Promise.all([1, 2, 3].map((index) => spawnApp(`api-${index}`, 'api')));
    processes.push(...apis);
    const wallet = await openWallet('100.00');

    const bodies = Array.from({ length: 150 }, () => wagerBody(wallet, 'BET', '1.00'));
    const requests = bodies.flatMap((body, index) => {
      const targets = [apis[index % 3]!, apis[(index + 1) % 3]!];
      return targets.map((api) =>
        fetch(`${api.baseUrl}/wagering/transactions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'Idempotency-Key': keyFor(body) },
          body: JSON.stringify(body),
        }).then(async (response) => ({ status: response.status, body: (await response.json()) as any })),
      );
    });
    const responses = await Promise.all(requests);

    expect(responses.every((response) => [200, 201, 422].includes(response.status))).toBe(true);
    const byKey = new Map<string, Set<string>>();
    for (const response of responses) {
      const key = response.body.transactionId;
      byKey.set(key, (byKey.get(key) ?? new Set()).add(response.body.status));
    }
    expect(byKey.size).toBe(150);
    expect([...byKey.values()].every((statuses) => statuses.size === 1)).toBe(true);

    const processed = await countRows(
      container.orm,
      `SELECT COUNT(*) AS count FROM wager_transactions WHERE wallet_id = ? AND kind = 'BET' AND status = 'PROCESSED'`,
      [wallet.id],
    );
    expect(processed).toBe(100);
    expect((await container.queries.getWallet(wallet.id)).balance.amount).toBe('0.00');
    await assertExactlyOnce([wallet.id]);
  });

  it('three workers consume the same queue with duplicates and out-of-order references', async () => {
    queues = await createTestQueues(container.sqs, 3);
    const consumerName = `mp-${newId()}`;
    const wallets = await Promise.all(Array.from({ length: 6 }, () => openWallet('1000.00')));

    const sends: Promise<void>[] = [];
    for (const wallet of wallets) {
      for (let round = 0; round < 10; round++) {
        const bet = wagerBody(wallet, 'BET', '10.00', { roundId: `r-${round}` });
        const win = wagerBody(wallet, 'WIN', '4.00', {
          roundId: `r-${round}`,
          referenceExternalTransactionId: bet.externalTransactionId,
        });
        const betMessage = wagerMessage({ ...bet, idempotencyKey: keyFor(bet) });
        const winMessage = wagerMessage({ ...win, idempotencyKey: keyFor(win) });
        const ordered = round % 3 === 0 ? [winMessage, betMessage, betMessage] : [betMessage, winMessage, winMessage];
        for (const message of ordered) {
          sends.push(sendWagerMessage(container.sqs, queues.urls.main, message, { groupId: wallet.id }));
        }
      }
    }
    await Promise.all(sends);

    await startWorkers(3, workerEnv(queues, consumerName));
    await waitFor(
      async () => {
        for (const wallet of wallets) {
          const balance = (await container.queries.getWallet(wallet.id)).balance.amount;
          if (balance !== '940.00') return false;
        }
        return (await approximateCount(container.sqs, queues!.urls.main)) === 0;
      },
      { timeoutMs: 60_000, intervalMs: 500, description: 'all wallets settled' },
    );

    const inboxRows = await countRows(container.orm, 'SELECT COUNT(*) AS count FROM inbox_messages WHERE consumer_name = ?', [
      consumerName,
    ]);
    expect(inboxRows).toBe(wallets.length * 20);
    expect(await receiveAll(container.sqs, queues.urls.deadLetter)).toHaveLength(0);
    await assertExactlyOnce(wallets.map((wallet) => wallet.id));

    await waitFor(
      async () =>
        (await countRows(
          container.orm,
          `SELECT COUNT(*) AS count FROM outbox_messages WHERE published_at IS NULL AND payload->'data'->>'walletId' = ANY(?::text[])`,
          [`{${wallets.map((wallet) => wallet.id).join(',')}}`],
        )) === 0,
      { timeoutMs: 30_000, description: 'outbox drained by concurrent publishers' },
    );
    const published = (await receiveAll(container.sqs, queues.urls.events)).map((message) => JSON.parse(message.Body!));
    const walletIds = new Set(wallets.map((wallet) => wallet.id));
    const ours = published.filter((event) => walletIds.has(event.data?.walletId));
    const uniqueEventIds = new Set(ours.map((event) => event.eventId));
    const expectedEvents = await countRows(
      container.orm,
      `SELECT COUNT(*) AS count FROM outbox_messages WHERE payload->'data'->>'walletId' = ANY(?::text[])`,
      [`{${wallets.map((wallet) => wallet.id).join(',')}}`],
    );
    expect(uniqueEventIds.size).toBe(expectedEvents);
  });

  it('survives workers killed mid-stream and a full restart with consistent final state', async () => {
    queues = await createTestQueues(container.sqs, 3);
    const consumerName = `kill-${newId()}`;
    const env = workerEnv(queues, consumerName);
    const wallets = await Promise.all(Array.from({ length: 8 }, () => openWallet('500.00')));
    const perWallet = 30;

    const sends: Promise<void>[] = [];
    for (const wallet of wallets) {
      for (let i = 0; i < perWallet; i++) {
        const bet = wagerBody(wallet, 'BET', '2.50');
        sends.push(
          sendWagerMessage(container.sqs, queues.urls.main, wagerMessage({ ...bet, idempotencyKey: keyFor(bet) }), {
            groupId: wallet.id,
          }),
        );
      }
    }
    await Promise.all(sends);

    const workers = await startWorkers(3, env, 'victim');
    const total = wallets.length * perWallet;
    const processedCount = () =>
      countRows(container.orm, 'SELECT COUNT(*) AS count FROM inbox_messages WHERE consumer_name = ?', [consumerName]);
    await waitFor(async () => (await processedCount()) >= total / 4, {
      timeoutMs: 60_000,
      description: 'a quarter of the stream processed',
    });

    await workers[0]!.stop('SIGKILL');
    await workers[1]!.stop('SIGKILL');
    await startWorkers(2, env, 'replacement');

    await waitFor(async () => (await processedCount()) >= total / 2, {
      timeoutMs: 60_000,
      description: 'half of the stream processed',
    });
    await stopAll(processes, 'SIGTERM');
    processes = [];

    await startWorkers(3, env, 'restarted');
    await waitFor(
      async () => (await processedCount()) === total && (await approximateCount(container.sqs, queues!.urls.main)) === 0,
      { timeoutMs: 90_000, intervalMs: 500, description: 'stream fully processed after restart' },
    );

    for (const wallet of wallets) {
      const report = await container.reconcileWallet.execute(wallet.id);
      expect(report.consistent).toBe(true);
      expect(report.storedBalance.amount).toBe('425.00');
      expect(report.checkedEntries).toBe(perWallet + 1);
    }
    await assertExactlyOnce(wallets.map((wallet) => wallet.id));
    expect(await receiveAll(container.sqs, queues.urls.deadLetter)).toHaveLength(0);
  });
});
