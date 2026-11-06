import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { PublishOutbox } from '../../src/application/outbox/publish-outbox';
import type { EventPublisher, PublishableEvent, UnitOfWork } from '../../src/application/ports';
import type { Container } from '../../src/container';
import { newId } from '../../src/domain/shared/id';
import { Money } from '../../src/domain/shared/money';
import { QueueUrlResolver } from '../../src/infrastructure/messaging/sqs-client';
import { SqsEventPublisher } from '../../src/infrastructure/messaging/sqs-event-publisher';
import { createTestContainer } from '../support/app';
import { countRows } from '../support/fixtures';
import { createTestQueues, receiveAll } from '../support/queues';

let container: Container;

beforeAll(async () => {
  container = await createTestContainer();
});

afterAll(async () => {
  await container.close();
});

class RecordingPublisher implements EventPublisher {
  readonly published: PublishableEvent[] = [];

  constructor(private readonly delayMs = 0) {}

  async publish(event: PublishableEvent): Promise<void> {
    if (this.delayMs) await Bun.sleep(this.delayMs);
    this.published.push(event);
  }
}

function publisherWith(eventPublisher: EventPublisher, batchSize = 10) {
  return new PublishOutbox(
    container.unitOfWork,
    eventPublisher,
    container.clock,
    container.metrics,
    container.logger,
    { batchSize },
  );
}

async function drain(publishers: PublishOutbox[]) {
  for (;;) {
    const results = await Promise.all(publishers.map((publisher) => publisher.runOnce()));
    if (results.every((result) => result.claimed === 0)) return;
  }
}

async function createEvents(count: number): Promise<string[]> {
  const walletIds: string[] = [];
  for (let i = 0; i < count; i++) {
    const wallet = await container.openWallet.execute({
      playerId: newId(),
      initialBalance: Money.from({ amount: '10.00', currency: 'BRL' }),
      correlationId: newId(),
    });
    walletIds.push(wallet.id);
  }
  return walletIds;
}

async function pendingFor(walletIds: string[]): Promise<number> {
  return countRows(
    container.orm,
    `SELECT COUNT(*) AS count FROM outbox_messages WHERE published_at IS NULL AND aggregate_id = ANY(?::text[])`,
    [`{${walletIds.join(',')}}`],
  );
}

describe('transactional outbox', () => {
  it('two concurrent publishers never publish the same row twice in the happy path', async () => {
    const walletIds = await createEvents(40);
    const first = new RecordingPublisher(5);
    const second = new RecordingPublisher(5);

    await drain([publisherWith(first), publisherWith(second)]);

    const ours = (events: PublishableEvent[]) => events.filter((event) => walletIds.includes(event.aggregateId));
    const ids = [...ours(first.published), ...ours(second.published)].map((event) => event.id);
    expect(ids).toHaveLength(40);
    expect(new Set(ids).size).toBe(40);
    expect(ours(first.published).length).toBeGreaterThan(0);
    expect(ours(second.published).length).toBeGreaterThan(0);
    expect(await pendingFor(walletIds)).toBe(0);
  });

  it('publishes events committed by an instance that died before publishing, from another instance', async () => {
    const walletIds = await createEvents(3);
    expect(await pendingFor(walletIds)).toBe(3);

    const otherInstance = await createTestContainer();
    try {
      const survivor = new RecordingPublisher();
      await drain([
        new PublishOutbox(
          otherInstance.unitOfWork,
          survivor,
          otherInstance.clock,
          otherInstance.metrics,
          otherInstance.logger,
          { batchSize: 10 },
        ),
      ]);
      expect(survivor.published.filter((event) => walletIds.includes(event.aggregateId))).toHaveLength(3);
      expect(await pendingFor(walletIds)).toBe(0);
    } finally {
      await otherInstance.close();
    }
  });

  it('re-publishes with the same event id when the publisher dies after sending and before committing', async () => {
    const walletIds = await createEvents(1);
    const sent: PublishableEvent[] = [];
    const dyingUnitOfWork: UnitOfWork = {
      run: (work) =>
        container.unitOfWork.run(async (scope) => {
          await work(scope);
          throw new Error('process killed before commit');
        }),
      read: (work) => container.unitOfWork.read(work),
      ping: () => container.unitOfWork.ping(),
    };
    const dying = new PublishOutbox(
      dyingUnitOfWork,
      { publish: async (event) => void sent.push(event) },
      container.clock,
      container.metrics,
      container.logger,
      { batchSize: 1000 },
    );
    await expect(dying.runOnce()).rejects.toThrow('process killed');
    expect(await pendingFor(walletIds)).toBe(1);

    const survivor = new RecordingPublisher();
    await drain([publisherWith(survivor)]);

    const firstAttempt = sent.find((event) => walletIds.includes(event.aggregateId))!;
    const secondAttempt = survivor.published.find((event) => walletIds.includes(event.aggregateId))!;
    expect(firstAttempt).toBeDefined();
    expect(secondAttempt.id).toBe(firstAttempt.id);
    expect(secondAttempt.payload).toEqual(firstAttempt.payload);
    expect(await pendingFor(walletIds)).toBe(0);
  });

  it('schedules a retry with backoff when publishing fails', async () => {
    const walletIds = await createEvents(1);
    const failing = publisherWith({
      publish: async (event) => {
        if (walletIds.includes(event.aggregateId)) throw new Error('sqs unavailable');
      },
    });
    await failing.runOnce();

    const [row] = await container.orm.em.fork().execute<
      Array<{ attempts: number; last_error: string; delay_ms: string }>
    >(
      `SELECT attempts, last_error, (EXTRACT(EPOCH FROM (next_attempt_at - now())) * 1000)::bigint::text AS delay_ms
         FROM outbox_messages WHERE aggregate_id = ?`,
      [walletIds[0]],
    );
    expect(row!.attempts).toBe(1);
    expect(row!.last_error).toBe('sqs unavailable');
    expect(Number(row!.delay_ms)).toBeGreaterThan(0);

    const recorder = new RecordingPublisher();
    await publisherWith(recorder).runOnce();
    expect(recorder.published.some((event) => walletIds.includes(event.aggregateId))).toBe(false);
  });

  it('publishes the envelope to a real SQS FIFO queue', async () => {
    const queues = await createTestQueues(container.sqs);
    try {
      const walletIds = await createEvents(2);
      const publisher = publisherWith(
        new SqsEventPublisher(container.sqs, new QueueUrlResolver(container.sqs), queues.events),
      );
      await drain([publisher]);

      const messages = (await receiveAll(container.sqs, queues.urls.events)).map((message) =>
        JSON.parse(message.Body!),
      );
      const ours = messages.filter((message) => walletIds.includes(message.aggregateId));
      expect(ours).toHaveLength(2);
      expect(ours[0]).toMatchObject({
        eventType: 'WalletBalanceChanged',
        version: 1,
        data: { balanceAfter: { amount: '10.00', currency: 'BRL' } },
      });
      expect(typeof ours[0].eventId).toBe('string');
      expect(typeof ours[0].occurredAt).toBe('string');
    } finally {
      await queues.cleanup();
    }
  });
});
