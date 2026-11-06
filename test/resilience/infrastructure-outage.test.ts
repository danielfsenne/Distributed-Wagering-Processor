import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { PublishOutbox } from '../../src/application/outbox/publish-outbox';
import { TRUSTED_INTERNAL_PRINCIPAL } from '../../src/application/provider-access';
import type { Container } from '../../src/container';
import { newId } from '../../src/domain/shared/id';
import { QueueUrlResolver } from '../../src/infrastructure/messaging/sqs-client';
import { SqsEventPublisher } from '../../src/infrastructure/messaging/sqs-event-publisher';
import { SqsWagerConsumer } from '../../src/infrastructure/messaging/sqs-wager-consumer';
import { type TestHttpApp, createTestContainer, startTestHttpApp } from '../support/app';
import { compose, composeOrThrow, eventually } from '../support/docker';
import { assertLedgerMatchesBalance, countRows, keyFor, wagerBody } from '../support/fixtures';
import { type TestQueues, createTestQueues, receiveAll, sendWagerMessage, wagerMessage } from '../support/queues';

let container: Container;
let http: TestHttpApp;
let queues: TestQueues;
const consumers: SqsWagerConsumer[] = [];

beforeAll(async () => {
  container = await createTestContainer({}, { SQS_REQUEST_TIMEOUT_MS: '5000', SQS_CONNECTION_TIMEOUT_MS: '2000' });
  http = await startTestHttpApp(container);
  queues = await createTestQueues(container.sqs, 5);
});

afterEach(async () => {
  await restoreInfrastructure();
  await Promise.all(consumers.splice(0).map((consumer) => consumer.stop(5_000)));
});

afterAll(async () => {
  await restoreInfrastructure();
  await queues.cleanup();
  await http.close();
  await container.close();
});

async function restoreInfrastructure() {
  await compose('unpause', 'localstack');
  await compose('start', 'postgres');
  await eventually(async () => (await container.unitOfWork.ping().then(() => true)), {
    description: 'postgres reachable',
  });
  await eventually(async () => (await container.queues.ping(queues.main).then(() => true)), {
    description: 'sqs reachable',
  });
}

async function request(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const response = await fetch(`${http.baseUrl}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return {
    status: response.status,
    headers: response.headers,
    body: (await response.json().catch(() => ({}))) as Record<string, any>,
  };
}

async function openWallet(amount: string) {
  const response = await request('POST', '/wallets', {
    playerId: newId(),
    initialBalance: { amount, currency: 'BRL' },
  });
  expect(response.status).toBe(201);
  return response.body as { id: string; playerId: string };
}

function startConsumer() {
  const consumer = new SqsWagerConsumer(container.sqs, container.queues, container.submitWager, container.metrics, container.logger, {
    queueName: queues.main,
    deadLetterQueueName: queues.deadLetter,
    consumerName: `resilience-${newId()}`,
    principal: TRUSTED_INTERNAL_PRINCIPAL,
    maxAttempts: 30,
    concurrency: 10,
    waitTimeSeconds: 1,
    visibilityTimeoutSeconds: 5,
    retryBaseDelaySeconds: 1,
    retryMaxDelaySeconds: 2,
  });
  consumers.push(consumer);
  consumer.start();
  return consumer;
}

describe('PostgreSQL unavailable', () => {
  it('answers 503, keeps queued messages, and converges exactly once after the database returns', async () => {
    const wallet = await openWallet('100.00');
    startConsumer();
    const httpBet = wagerBody(wallet, 'BET', '10.00');
    const queuedBet = wagerBody(wallet, 'BET', '15.00');

    await composeOrThrow('stop', 'postgres');

    const startedAt = Date.now();
    const unavailable = await request('POST', '/wagering/transactions', httpBet, { 'Idempotency-Key': keyFor(httpBet) });
    expect(unavailable.status).toBe(503);
    expect(unavailable.body.error).toMatchObject({ code: 'TRANSIENT_FAILURE', retryable: true });
    expect(unavailable.headers.get('retry-after')).toBe('1');
    expect(Date.now() - startedAt).toBeLessThan(20_000);

    const readiness = await request('GET', '/health/ready');
    expect(readiness.status).toBe(503);
    expect(readiness.body.checks).toEqual({ postgres: 'down', sqs: 'up' });
    expect((await request('GET', '/health/live')).status).toBe(200);

    await sendWagerMessage(
      container.sqs,
      queues.urls.main,
      wagerMessage({ ...queuedBet, idempotencyKey: keyFor(queuedBet) }),
      { groupId: wallet.id },
    );
    await Bun.sleep(4_000);

    await composeOrThrow('start', 'postgres');
    await eventually(async () => (await request('GET', '/health/ready')).status === 200, {
      description: 'readiness restored',
    });

    const retried = await request('POST', '/wagering/transactions', httpBet, { 'Idempotency-Key': keyFor(httpBet) });
    expect(retried.status).toBe(201);
    const replay = await request('POST', '/wagering/transactions', httpBet, { 'Idempotency-Key': keyFor(httpBet) });
    expect(replay.status).toBe(200);
    expect(replay.body.transactionId).toBe(retried.body.transactionId);

    await eventually(async () => (await request('GET', `/wallets/${wallet.id}`)).body.balance?.amount === '75.00', {
      description: 'queued message applied after recovery',
    });
    expect(await receiveAll(container.sqs, queues.urls.deadLetter)).toHaveLength(0);
    expect(
      await countRows(
        container.orm,
        `SELECT COUNT(*) AS count FROM wallet_ledger_entries WHERE wallet_id = ? AND direction = 'DEBIT'`,
        [wallet.id],
      ),
    ).toBe(2);
    const reconciliation = await request('POST', `/wallets/${wallet.id}/reconciliation`);
    expect(reconciliation.body.consistent).toBe(true);
    await assertLedgerMatchesBalance(container.orm, wallet.id);
  });
});

describe('SQS unavailable', () => {
  it('keeps the financial path available, holds events in the outbox and publishes them after recovery', async () => {
    const wallet = await openWallet('100.00');
    const publisher = new PublishOutbox(
      container.unitOfWork,
      new SqsEventPublisher(container.sqs, new QueueUrlResolver(container.sqs), queues.events),
      container.clock,
      container.metrics,
      container.logger,
      { batchSize: 50 },
    );
    const consumer = startConsumer();

    await composeOrThrow('pause', 'localstack');

    const bet = wagerBody(wallet, 'BET', '20.00');
    const accepted = await request('POST', '/wagering/transactions', bet, { 'Idempotency-Key': keyFor(bet) });
    expect(accepted.status).toBe(201);
    expect(accepted.body.balance.amount).toBe('80.00');

    const readiness = await request('GET', '/health/ready');
    expect(readiness.status).toBe(503);
    expect(readiness.body.checks).toEqual({ postgres: 'up', sqs: 'down' });

    const failedRun = await publisher.runOnce();
    expect(failedRun.failed).toBeGreaterThan(0);
    const [pending] = await container.orm.em.fork().execute<
      Array<{ attempts: number; last_error: string | null; published_at: Date | null }>
    >(
      `SELECT attempts, last_error, published_at FROM outbox_messages
        WHERE aggregate_id = ? AND event_type = 'WagerTransactionProcessed'`,
      [accepted.body.transactionId],
    );
    expect(pending!.published_at).toBeNull();
    expect(pending!.attempts).toBeGreaterThanOrEqual(1);
    expect(pending!.last_error).not.toBeNull();

    await composeOrThrow('unpause', 'localstack');
    await eventually(async () => (await request('GET', '/health/ready')).status === 200, {
      description: 'readiness restored',
    });

    await eventually(
      async () => {
        await publisher.runOnce();
        return (
          (await countRows(
            container.orm,
            `SELECT COUNT(*) AS count FROM outbox_messages WHERE aggregate_id = ? AND published_at IS NULL`,
            [accepted.body.transactionId],
          )) === 0
        );
      },
      { timeoutMs: 90_000, intervalMs: 1_000, description: 'outbox drained after recovery' },
    );
    const published = (await receiveAll(container.sqs, queues.urls.events)).map((message) => JSON.parse(message.Body!));
    expect(
      published.filter((event) => event.aggregateId === accepted.body.transactionId).map((event) => event.eventType),
    ).toEqual(['WagerTransactionProcessed']);

    const queuedBet = wagerBody(wallet, 'BET', '5.00');
    await sendWagerMessage(
      container.sqs,
      queues.urls.main,
      wagerMessage({ ...queuedBet, idempotencyKey: keyFor(queuedBet) }),
      { groupId: wallet.id },
    );
    await eventually(async () => (await request('GET', `/wallets/${wallet.id}`)).body.balance?.amount === '75.00', {
      description: 'consumer recovered without restart',
    });
    expect(consumer).toBeDefined();
    await assertLedgerMatchesBalance(container.orm, wallet.id);
  });
});
