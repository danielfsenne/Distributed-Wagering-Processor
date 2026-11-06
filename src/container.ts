import type { SQSClient } from '@aws-sdk/client-sqs';
import { MikroORM } from '@mikro-orm/postgresql';
import type { Clock, EventPublisher, UnitOfWork } from './application/ports';
import { ResolvePendingReferences } from './application/wagering/resolve-pending-references';
import { SubmitWagerTransaction } from './application/wagering/submit-wager-transaction';
import { WagerProcessor } from './application/wagering/wager-processor';
import { OpenWallet } from './application/wallets/open-wallet';
import { ReconcileWallet } from './application/wallets/reconcile-wallet';
import { WalletQueries } from './application/wallets/wallet-queries';
import type { AppConfig } from './config';
import { ReferenceRetryPolicy } from './domain/wagering/reference-retry-policy';
import { QueueUrlResolver, createSqsClient } from './infrastructure/messaging/sqs-client';
import { SqsEventPublisher } from './infrastructure/messaging/sqs-event-publisher';
import { PinoAppLogger, createRootLogger } from './infrastructure/observability/logger';
import { PrometheusMetrics } from './infrastructure/observability/prometheus-metrics';
import { MikroOrmUnitOfWork } from './infrastructure/persistence/mikro-orm-unit-of-work';
import { createOrmConfig } from './infrastructure/persistence/mikro-orm.config';

export interface Container {
  config: AppConfig;
  orm: MikroORM;
  unitOfWork: UnitOfWork;
  clock: Clock;
  logger: PinoAppLogger;
  metrics: PrometheusMetrics;
  sqs: SQSClient;
  queues: QueueUrlResolver;
  eventPublisher: EventPublisher;
  processor: WagerProcessor;
  submitWager: SubmitWagerTransaction;
  resolvePendingReferences: ResolvePendingReferences;
  openWallet: OpenWallet;
  reconcileWallet: ReconcileWallet;
  queries: WalletQueries;
  close(): Promise<void>;
}

export interface ContainerOverrides {
  clock?: Clock;
  metrics?: PrometheusMetrics;
  logger?: PinoAppLogger;
  eventPublisher?: EventPublisher;
}

export const systemClock: Clock = { now: () => new Date() };

export async function createContainer(
  config: AppConfig,
  overrides: ContainerOverrides = {},
): Promise<Container> {
  const logger = overrides.logger ?? new PinoAppLogger(createRootLogger());
  const metrics = overrides.metrics ?? new PrometheusMetrics();
  const clock = overrides.clock ?? systemClock;

  const orm = await MikroORM.init(
    createOrmConfig({ databaseUrl: config.databaseUrl, poolMax: config.dbPoolMax }),
  );
  const unitOfWork = new MikroOrmUnitOfWork(orm, {
    lockTimeoutMs: config.lockTimeoutMs,
    statementTimeoutMs: Math.max(15_000, config.lockTimeoutMs * 3),
  });

  const sqs = createSqsClient(config.aws);
  const queues = new QueueUrlResolver(sqs);
  const eventPublisher =
    overrides.eventPublisher ?? new SqsEventPublisher(sqs, queues, config.queues.events);

  const retryPolicy = ReferenceRetryPolicy.of({
    maxAttempts: config.references.maxAttempts,
    baseDelayMs: config.references.baseDelayMs,
    maxDelayMs: config.references.maxDelayMs,
  });
  const processor = new WagerProcessor(retryPolicy);

  return {
    config,
    orm,
    unitOfWork,
    clock,
    logger,
    metrics,
    sqs,
    queues,
    eventPublisher,
    processor,
    submitWager: new SubmitWagerTransaction(unitOfWork, processor, clock, metrics, logger),
    resolvePendingReferences: new ResolvePendingReferences(unitOfWork, processor, clock, metrics, logger, {
      batchSize: config.references.batchSize,
      leaseMs: config.references.leaseMs,
    }),
    openWallet: new OpenWallet(unitOfWork, clock, logger),
    reconcileWallet: new ReconcileWallet(unitOfWork, metrics, logger),
    queries: new WalletQueries(unitOfWork),
    async close() {
      sqs.destroy();
      await orm.close(true);
    },
  };
}
