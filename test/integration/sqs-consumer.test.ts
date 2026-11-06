import { TRUSTED_INTERNAL_PRINCIPAL, principalFor } from '../../src/application/provider-access';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { ReceiveMessageCommand } from '@aws-sdk/client-sqs';
import { TransientError } from '../../src/application/errors';
import type { UnitOfWork } from '../../src/application/ports';
import { SubmitWagerTransaction } from '../../src/application/wagering/submit-wager-transaction';
import type { Container } from '../../src/container';
import { newId } from '../../src/domain/shared/id';
import { Money } from '../../src/domain/shared/money';
import { type SqsConsumerOptions, SqsWagerConsumer } from '../../src/infrastructure/messaging/sqs-wager-consumer';
import { createTestContainer } from '../support/app';
import { assertLedgerMatchesBalance, countRows, keyFor, wagerBody } from '../support/fixtures';
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
let queues: TestQueues;
const consumers: SqsWagerConsumer[] = [];

beforeAll(async () => {
  container = await createTestContainer();
});

afterEach(async () => {
  await Promise.all(consumers.splice(0).map((consumer) => consumer.stop(5_000)));
  await queues?.cleanup();
});

afterAll(async () => {
  await container.close();
});

function options(overrides: Partial<SqsConsumerOptions> = {}): SqsConsumerOptions {
  return {
    queueName: queues.main,
    deadLetterQueueName: queues.deadLetter,
    consumerName: `consumer-${newId()}`,
    principal: TRUSTED_INTERNAL_PRINCIPAL,
    maxAttempts: 3,
    concurrency: 10,
    waitTimeSeconds: 1,
    visibilityTimeoutSeconds: 30,
    retryBaseDelaySeconds: 1,
    retryMaxDelaySeconds: 2,
    ...overrides,
  };
}

function consumer(submit: SubmitWagerTransaction = container.submitWager, overrides: Partial<SqsConsumerOptions> = {}) {
  const instance = new SqsWagerConsumer(
    container.sqs,
    container.queues,
    submit,
    container.metrics,
    container.logger,
    options(overrides),
  );
  consumers.push(instance);
  return instance;
}

async function openWallet(amount = '100.00') {
  return container.openWallet.execute({
    playerId: newId(),
    initialBalance: Money.from({ amount, currency: 'BRL' }),
    correlationId: newId(),
  });
}

function messageFor(wallet: { id: string; playerId: string }, kind: string, amount: string, extra = {}) {
  const body = wagerBody(wallet, kind, amount, extra);
  return { body, message: wagerMessage({ ...body, idempotencyKey: keyFor(body) }) };
}

async function balanceOf(walletId: string): Promise<string> {
  return (await container.queries.getWallet(walletId)).balance.amount;
}

describe('SQS consumer', () => {
  it('processes a message through the same use case and acks after commit', async () => {
    queues = await createTestQueues(container.sqs);
    const wallet = await openWallet('100.00');
    const { message } = messageFor(wallet, 'BET', '25.00');
    await sendWagerMessage(container.sqs, queues.urls.main, message, { groupId: wallet.id });

    consumer().start();
    await waitFor(async () => (await balanceOf(wallet.id)) === '75.00', { description: 'debit' });
    await waitFor(async () => (await approximateCount(container.sqs, queues.urls.main)) === 0, {
      description: 'ack',
    });
    await assertLedgerMatchesBalance(container.orm, wallet.id);
  });

  it('dedupes redelivered messages through the persistent inbox', async () => {
    queues = await createTestQueues(container.sqs);
    const wallet = await openWallet('100.00');
    const { message } = messageFor(wallet, 'BET', '10.00');
    for (let i = 0; i < 3; i++) {
      await sendWagerMessage(container.sqs, queues.urls.main, message, { groupId: wallet.id });
    }

    consumer().start();
    await waitFor(async () => (await approximateCount(container.sqs, queues.urls.main)) === 0, {
      description: 'all deliveries acked',
    });
    expect(await balanceOf(wallet.id)).toBe('90.00');
    expect(
      await countRows(container.orm, 'SELECT COUNT(*) AS count FROM inbox_messages WHERE message_id = ?', [
        message.messageId,
      ]),
    ).toBe(1);
    await assertLedgerMatchesBalance(container.orm, wallet.id);
  });

  it('acks business rejections as terminal', async () => {
    queues = await createTestQueues(container.sqs);
    const wallet = await openWallet('5.00');
    const { body, message } = messageFor(wallet, 'BET', '10.00');
    await sendWagerMessage(container.sqs, queues.urls.main, message, { groupId: wallet.id });

    consumer().start();
    const transaction = await waitFor(
      async () => {
        try {
          return await container.queries.getTransactionByExternalId(body.providerId, body.externalTransactionId);
        } catch {
          return undefined;
        }
      },
      { description: 'rejected transaction' },
    );
    expect(transaction.status).toBe('REJECTED');
    expect(transaction.failureCode).toBe('INSUFFICIENT_FUNDS');
    await waitFor(async () => (await approximateCount(container.sqs, queues.urls.main)) === 0, { description: 'ack' });
    expect(await receiveAll(container.sqs, queues.urls.deadLetter)).toHaveLength(0);
  });

  it.each([
    ['malformed JSON', '{"messageId":'],
    ['wrong type', { messageId: 'm', type: 'Other', data: {} }],
    ['invalid money', wagerMessage({ providerId: 'p', kind: 'BET', money: { amount: '1e2', currency: 'BRL' } })],
  ])('moves permanently invalid messages (%s) to the DLQ', async (_name, payload) => {
    queues = await createTestQueues(container.sqs);
    await sendWagerMessage(container.sqs, queues.urls.main, payload, { groupId: 'g' });
    consumer().start();

    const deadLetters = await waitFor(
      async () => {
        const messages = await receiveAll(container.sqs, queues.urls.deadLetter);
        return messages.length > 0 ? messages : undefined;
      },
      { description: 'dead letter' },
    );
    expect(deadLetters).toHaveLength(1);
    expect(deadLetters[0]!.MessageAttributes?.reason?.StringValue).toBe('invalid_message');
    expect(await approximateCount(container.sqs, queues.urls.main)).toBe(0);
  });

  it('applies the same provider validation to queue messages and dead-letters unauthorized providers', async () => {
    queues = await createTestQueues(container.sqs);
    const wallet = await openWallet('100.00');
    const { message } = messageFor(wallet, 'BET', '10.00');
    await sendWagerMessage(container.sqs, queues.urls.main, message, { groupId: wallet.id });

    consumer(container.submitWager, { principal: principalFor('sqs:restricted', 'provider-b') }).start();
    const deadLetters = await waitFor(
      async () => {
        const messages = await receiveAll(container.sqs, queues.urls.deadLetter);
        return messages.length > 0 ? messages : undefined;
      },
      { description: 'dead letter' },
    );
    expect(deadLetters[0]!.MessageAttributes?.reason?.StringValue).toBe('provider_not_allowed');
    expect(await balanceOf(wallet.id)).toBe('100.00');
  });

  it('moves idempotency conflicts to the DLQ', async () => {
    queues = await createTestQueues(container.sqs);
    const wallet = await openWallet('100.00');
    const { body, message } = messageFor(wallet, 'BET', '10.00');
    await sendWagerMessage(container.sqs, queues.urls.main, message, { groupId: wallet.id });
    const conflicting = wagerMessage({ ...body, money: { amount: '11.00', currency: 'BRL' }, idempotencyKey: keyFor(body) });
    await sendWagerMessage(container.sqs, queues.urls.main, conflicting, { groupId: wallet.id });

    consumer().start();
    const deadLetters = await waitFor(
      async () => {
        const messages = await receiveAll(container.sqs, queues.urls.deadLetter);
        return messages.length > 0 ? messages : undefined;
      },
      { description: 'dead letter' },
    );
    expect(deadLetters[0]!.MessageAttributes?.reason?.StringValue).toBe('idempotency_key_conflict');
    expect(await balanceOf(wallet.id)).toBe('90.00');
  });

  it('retries transient failures with backoff and then succeeds', async () => {
    queues = await createTestQueues(container.sqs);
    const wallet = await openWallet('100.00');
    const { message } = messageFor(wallet, 'BET', '10.00');
    await sendWagerMessage(container.sqs, queues.urls.main, message, { groupId: wallet.id });

    let failuresLeft = 1;
    const flaky: UnitOfWork = {
      run: (work) => {
        if (failuresLeft-- > 0) return Promise.reject(new TransientError('database unavailable'));
        return container.unitOfWork.run(work);
      },
      read: (work) => container.unitOfWork.read(work),
      ping: () => container.unitOfWork.ping(),
    };
    const submit = new SubmitWagerTransaction(
      flaky,
      container.processor,
      container.clock,
      container.metrics,
      container.logger,
    );

    const startedAt = Date.now();
    consumer(submit).start();
    await waitFor(async () => (await balanceOf(wallet.id)) === '90.00', { description: 'eventual debit' });
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(900);
    await waitFor(async () => (await approximateCount(container.sqs, queues.urls.main)) === 0, { description: 'ack' });
    expect(await receiveAll(container.sqs, queues.urls.deadLetter)).toHaveLength(0);
  });

  it('moves a message to the DLQ after the attempt limit', async () => {
    queues = await createTestQueues(container.sqs);
    const wallet = await openWallet('100.00');
    const { message } = messageFor(wallet, 'BET', '10.00');
    await sendWagerMessage(container.sqs, queues.urls.main, message, { groupId: wallet.id });

    const broken: UnitOfWork = {
      run: () => Promise.reject(new TransientError('database unavailable')),
      read: (work) => container.unitOfWork.read(work),
      ping: () => container.unitOfWork.ping(),
    };
    const submit = new SubmitWagerTransaction(
      broken,
      container.processor,
      container.clock,
      container.metrics,
      container.logger,
    );
    consumer(submit, { maxAttempts: 2, retryBaseDelaySeconds: 1 }).start();

    const deadLetters = await waitFor(
      async () => {
        const messages = await receiveAll(container.sqs, queues.urls.deadLetter);
        return messages.length > 0 ? messages : undefined;
      },
      { description: 'dead letter after retries', timeoutMs: 20_000 },
    );
    expect(deadLetters[0]!.MessageAttributes?.reason?.StringValue).toBe('retries_exhausted');
    expect(await balanceOf(wallet.id)).toBe('100.00');
  });

  it('is safe when the worker dies after commit and before ack', async () => {
    queues = await createTestQueues(container.sqs, 2);
    const wallet = await openWallet('100.00');
    const { message } = messageFor(wallet, 'BET', '40.00');
    await sendWagerMessage(container.sqs, queues.urls.main, message, { groupId: wallet.id });

    const { Messages = [] } = await container.sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: queues.urls.main,
        MaxNumberOfMessages: 1,
        WaitTimeSeconds: 2,
        VisibilityTimeout: 2,
      }),
    );
    expect(Messages).toHaveLength(1);
    const delivered = JSON.parse(Messages[0]!.Body!);
    await container.submitWager.execute({
      idempotencyKey: delivered.data.idempotencyKey,
      payload: (await import('../../src/application/wagering/wager-payload')).parseWagerPayload(delivered.data),
      correlationId: newId(),
      source: 'sqs',
      principal: TRUSTED_INTERNAL_PRINCIPAL,
      inbox: {
        consumerName: 'crash-test',
        messageId: delivered.messageId,
        messageHash: (await import('../../src/application/idempotency/payload-hash')).sha256Hex(Messages[0]!.Body!),
      },
    });
    expect(await balanceOf(wallet.id)).toBe('60.00');

    consumer(container.submitWager, { consumerName: 'crash-test' }).start();
    await waitFor(async () => (await approximateCount(container.sqs, queues.urls.main)) === 0, {
      description: 'redelivered message acked',
      timeoutMs: 20_000,
    });
    expect(await balanceOf(wallet.id)).toBe('60.00');
    await assertLedgerMatchesBalance(container.orm, wallet.id);
  });

  it('releases visibility of unstarted messages on shutdown', async () => {
    queues = await createTestQueues(container.sqs, 60);
    const wallet = await openWallet('100.00');
    const first = messageFor(wallet, 'BET', '1.00');
    const second = messageFor(wallet, 'BET', '2.00');
    await sendWagerMessage(container.sqs, queues.urls.main, first.message, { groupId: wallet.id });
    await sendWagerMessage(container.sqs, queues.urls.main, second.message, { groupId: wallet.id });

    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started = false;
    const slow: UnitOfWork = {
      run: async (work) => {
        started = true;
        await gate;
        return container.unitOfWork.run(work);
      },
      read: (work) => container.unitOfWork.read(work),
      ping: () => container.unitOfWork.ping(),
    };
    const submit = new SubmitWagerTransaction(slow, container.processor, container.clock, container.metrics, container.logger);
    const instance = consumer(submit);
    instance.start();
    await waitFor(async () => started, { description: 'first message in flight' });

    const stopping = instance.stop(10_000);
    await Bun.sleep(200);
    release();
    await stopping;

    expect(await balanceOf(wallet.id)).toBe('99.00');
    const next = consumer();
    next.start();
    await waitFor(async () => (await balanceOf(wallet.id)) === '97.00', {
      description: 'released message processed by another consumer',
      timeoutMs: 10_000,
    });
  });
});
