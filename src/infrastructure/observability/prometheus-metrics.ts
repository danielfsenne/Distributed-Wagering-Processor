import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';
import type { Metrics, TransactionSource } from '../../application/ports';

export class PrometheusMetrics implements Metrics {
  readonly registry = new Registry();

  private readonly transactions = new Counter({
    name: 'wagering_transactions_total',
    help: 'Wager transactions settled, by resulting status',
    labelNames: ['status', 'kind', 'source'],
    registers: [this.registry],
  });

  private readonly duplicates = new Counter({
    name: 'wagering_duplicates_detected_total',
    help: 'Duplicate deliveries answered as idempotent replays',
    labelNames: ['source'],
    registers: [this.registry],
  });

  private readonly retries = new Counter({
    name: 'wagering_retries_total',
    help: 'Retries performed, by component and reason',
    labelNames: ['component', 'reason'],
    registers: [this.registry],
  });

  private readonly lockConflicts = new Counter({
    name: 'wagering_lock_conflicts_total',
    help: 'Concurrency conflicts (lock timeouts, deadlocks, version mismatches)',
    labelNames: ['reason'],
    registers: [this.registry],
  });

  private readonly deadLetters = new Counter({
    name: 'wagering_dlq_messages_total',
    help: 'Messages moved to the dead-letter queue',
    labelNames: ['reason'],
    registers: [this.registry],
  });

  private readonly latency = new Histogram({
    name: 'wagering_processing_duration_seconds',
    help: 'End-to-end processing latency of a wager transaction',
    labelNames: ['source'],
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    registers: [this.registry],
  });

  private readonly outboxPublishedCounter = new Counter({
    name: 'wagering_outbox_published_total',
    help: 'Outbox messages published',
    registers: [this.registry],
  });

  private readonly outboxFailures = new Counter({
    name: 'wagering_outbox_publish_failures_total',
    help: 'Outbox publish attempts that failed and were rescheduled',
    registers: [this.registry],
  });

  private readonly outboxPending = new Gauge({
    name: 'wagering_outbox_pending_messages',
    help: 'Outbox messages not yet published',
    registers: [this.registry],
  });

  private readonly outboxLag = new Gauge({
    name: 'wagering_outbox_lag_seconds',
    help: 'Age of the oldest unpublished outbox message',
    registers: [this.registry],
  });

  private readonly reconciliationDivergences = new Counter({
    name: 'wagering_reconciliation_divergences_total',
    help: 'Reconciliations where stored balance differs from the ledger',
    registers: [this.registry],
  });

  constructor(collectDefaults = true) {
    if (collectDefaults) {
      collectDefaultMetrics({ register: this.registry });
    }
  }

  transactionSettled(status: string, kind: string, source: TransactionSource): void {
    this.transactions.inc({ status, kind, source });
  }

  duplicateDetected(source: TransactionSource | 'inbox'): void {
    this.duplicates.inc({ source });
  }

  retry(component: string, reason: string): void {
    this.retries.inc({ component, reason });
  }

  lockConflict(reason: string): void {
    this.lockConflicts.inc({ reason });
  }

  deadLettered(reason: string): void {
    this.deadLetters.inc({ reason });
  }

  processingDuration(source: TransactionSource, seconds: number): void {
    this.latency.observe({ source }, seconds);
  }

  outboxPublished(count: number): void {
    this.outboxPublishedCounter.inc(count);
  }

  outboxPublishFailed(): void {
    this.outboxFailures.inc();
  }

  outboxState(pending: number, oldestPendingAgeSeconds: number): void {
    this.outboxPending.set(pending);
    this.outboxLag.set(oldestPendingAgeSeconds);
  }

  reconciliationDivergence(): void {
    this.reconciliationDivergences.inc();
  }

  async render(): Promise<{ contentType: string; body: string }> {
    return { contentType: this.registry.contentType, body: await this.registry.metrics() };
  }
}
