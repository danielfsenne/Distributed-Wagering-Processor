import { PublishOutbox } from './application/outbox/publish-outbox';
import type { Container } from './container';
import { SqsWagerConsumer } from './infrastructure/messaging/sqs-wager-consumer';
import { PeriodicTask } from './infrastructure/scheduling/periodic-task';

export interface Worker {
  consumer: SqsWagerConsumer;
  publishOutbox: PublishOutbox;
  stop(timeoutMs: number): Promise<void>;
}

export interface WorkerComponents {
  consumer?: boolean;
  outbox?: boolean;
  references?: boolean;
}

export function startWorker(container: Container, components: WorkerComponents = {}): Worker {
  const { config, logger } = container;
  const enabled = { consumer: true, outbox: true, references: true, ...components };

  const consumer = new SqsWagerConsumer(
    container.sqs,
    container.queues,
    container.submitWager,
    container.metrics,
    logger,
    {
      queueName: config.queues.transactions,
      deadLetterQueueName: config.queues.deadLetter,
      consumerName: config.consumer.name,
      maxAttempts: config.consumer.maxAttempts,
      concurrency: config.consumer.concurrency,
      waitTimeSeconds: config.consumer.waitTimeSeconds,
      visibilityTimeoutSeconds: config.consumer.visibilityTimeoutSeconds,
      retryBaseDelaySeconds: config.consumer.retryBaseDelaySeconds,
      retryMaxDelaySeconds: config.consumer.retryMaxDelaySeconds,
    },
  );

  const publishOutbox = new PublishOutbox(
    container.unitOfWork,
    container.eventPublisher,
    container.clock,
    container.metrics,
    logger,
    { batchSize: config.outbox.batchSize },
  );

  const outboxTask = new PeriodicTask({
    name: 'outbox-publisher',
    intervalMs: config.outbox.intervalMs,
    logger,
    run: async () => {
      const summary = await publishOutbox.runOnce();
      return { busy: summary.claimed === config.outbox.batchSize && summary.failed === 0 };
    },
  });

  const referenceTask = new PeriodicTask({
    name: 'pending-reference-resolver',
    intervalMs: config.references.intervalMs,
    logger,
    run: async () => {
      const summary = await container.resolvePendingReferences.runOnce();
      return { busy: summary.claimed === config.references.batchSize };
    },
  });

  if (enabled.consumer) consumer.start();
  if (enabled.outbox) outboxTask.start();
  if (enabled.references) referenceTask.start();
  logger.info('worker started', enabled);

  return {
    consumer,
    publishOutbox,
    async stop(timeoutMs: number) {
      await Promise.all([consumer.stop(timeoutMs), outboxTask.stop(), referenceTask.stop()]);
      logger.info('worker stopped');
    },
  };
}
