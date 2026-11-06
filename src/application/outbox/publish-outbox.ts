import type { Clock, EventPublisher, Logger, Metrics, UnitOfWork } from '../ports';

export interface PublishOutboxOptions {
  batchSize: number;
}

export interface PublishSummary {
  claimed: number;
  published: number;
  failed: number;
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
      const claimed = await scope.outbox.claimDue(this.clock.now(), this.options.batchSize);
      const result: PublishSummary = { claimed: claimed.length, published: 0, failed: 0 };
      for (const { message } of claimed) {
        try {
          await this.publisher.publish({
            id: message.id,
            aggregateId: message.aggregateId,
            eventType: message.eventType,
            payload: message.payload,
          });
          message.markPublished(this.clock.now());
          await scope.outbox.markPublished(message);
          result.published++;
        } catch (error) {
          message.scheduleRetry(this.clock.now());
          await scope.outbox.scheduleRetry(message, (error as Error).message ?? String(error));
          result.failed++;
          this.metrics.outboxPublishFailed();
          this.logger.warn('outbox publish failed', {
            eventId: message.id,
            eventType: message.eventType,
            attempts: message.attempts,
            nextAttemptAt: message.nextAttemptAt?.toISOString(),
            error: (error as Error).message,
          });
        }
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
}
