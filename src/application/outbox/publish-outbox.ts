import type { OutboxMessage } from '../../domain/messaging/outbox-message';
import type {
  Clock,
  EventPublisher,
  Logger,
  Metrics,
  PublishableEvent,
  PublishFailure,
  UnitOfWork,
} from '../ports';

export interface PublishOutboxOptions {
  batchSize: number;
}

export interface PublishSummary {
  claimed: number;
  published: number;
  failed: number;
}

function toPublishable(message: OutboxMessage): PublishableEvent {
  return {
    id: message.id,
    aggregateId: message.aggregateId,
    eventType: message.eventType,
    payload: message.payload,
  };
}

export class PublishOutbox {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly publisher: EventPublisher,
    private readonly clock: Clock,
    private readonly metrics: Metrics,
    private readonly logger: Logger,
    private readonly options: PublishOutboxOptions = { batchSize: 50 },
  ) {}

  async runOnce(): Promise<PublishSummary> {
    const summary = await this.unitOfWork.run(async (scope) => {
      const claimed = (await scope.outbox.claimDue(this.clock.now(), this.options.batchSize)).map(
        ({ message }) => message,
      );
      const failures = new Map(
        (await this.publish(claimed)).map((failure) => [failure.id, failure.error] as const),
      );
      const result: PublishSummary = { claimed: claimed.length, published: 0, failed: 0 };
      const publishedAt = this.clock.now();
      const published = claimed.filter((message) => !failures.has(message.id));
      for (const message of published) {
        message.markPublished(publishedAt);
      }
      await scope.outbox.markPublished(published, publishedAt);
      result.published = published.length;
      for (const message of claimed) {
        const error = failures.get(message.id);
        if (error === undefined) {
          continue;
        }
        message.scheduleRetry(this.clock.now());
        await scope.outbox.scheduleRetry(message, error);
        result.failed++;
        this.metrics.outboxPublishFailed();
        this.logger.warn('outbox publish failed', {
          eventId: message.id,
          eventType: message.eventType,
          attempts: message.attempts,
          nextAttemptAt: message.nextAttemptAt?.toISOString(),
          error,
        });
      }
      return result;
    });
    if (summary.published > 0) {
      this.metrics.outboxPublished(summary.published);
    }
    await this.refreshLag();
    return summary;
  }

  async refreshLag(): Promise<void> {
    const stats = await this.unitOfWork.read((scope) => scope.outbox.stats(this.clock.now()));
    this.metrics.outboxState(stats.pending, stats.oldestPendingAgeSeconds);
  }

  private async publish(messages: OutboxMessage[]): Promise<PublishFailure[]> {
    const events = messages.map(toPublishable);
    if (this.publisher.publishAll) {
      return this.publisher.publishAll(events);
    }
    const failures: PublishFailure[] = [];
    for (const event of events) {
      try {
        await this.publisher.publish(event);
      } catch (error) {
        failures.push({ id: event.id, error: (error as Error).message ?? String(error) });
      }
    }
    return failures;
  }
}
