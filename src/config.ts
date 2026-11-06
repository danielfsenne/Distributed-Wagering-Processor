export type AppMode = 'api' | 'worker' | 'all';

export interface AppConfig {
  mode: AppMode;
  port: number;
  opsPort: number;
  databaseUrl: string;
  dbPoolMax: number;
  lockTimeoutMs: number;
  aws: {
    endpoint: string | undefined;
    region: string;
  };
  queues: {
    transactions: string;
    deadLetter: string;
    events: string;
  };
  consumer: {
    name: string;
    allowedProviders: string;
    maxAttempts: number;
    concurrency: number;
    waitTimeSeconds: number;
    visibilityTimeoutSeconds: number;
    retryBaseDelaySeconds: number;
    retryMaxDelaySeconds: number;
  };
  outbox: {
    batchSize: number;
    intervalMs: number;
  };
  references: {
    batchSize: number;
    intervalMs: number;
    leaseMs: number;
    maxAttempts: number;
    baseDelayMs: number;
    maxDelayMs: number;
  };
  shutdownTimeoutMs: number;
}

const int = (env: NodeJS.ProcessEnv, name: string, fallback: number): number => {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`Environment variable ${name} must be a non-negative integer`);
  }
  return value;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env, mode?: AppMode): AppConfig {
  const resolvedMode = mode ?? ((env.APP_MODE as AppMode | undefined) ?? 'all');
  return {
    mode: resolvedMode,
    port: int(env, 'PORT', 3000),
    opsPort: int(env, 'OPS_PORT', 9100),
    databaseUrl: env.DATABASE_URL ?? 'postgres://wagering:wagering@localhost:55432/wagering',
    dbPoolMax: int(env, 'DB_POOL_MAX', 20),
    lockTimeoutMs: int(env, 'DB_LOCK_TIMEOUT_MS', 5_000),
    aws: {
      endpoint: env.AWS_ENDPOINT_URL ?? 'http://localhost:4566',
      region: env.AWS_REGION ?? 'us-east-1',
    },
    queues: {
      transactions: env.SQS_TRANSACTIONS_QUEUE ?? 'wager-transactions.fifo',
      deadLetter: env.SQS_DLQ_QUEUE ?? 'wager-transactions-dlq.fifo',
      events: env.SQS_EVENTS_QUEUE ?? 'wagering-events.fifo',
    },
    consumer: {
      name: env.CONSUMER_NAME ?? 'wager-transactions-consumer',
      allowedProviders: env.CONSUMER_ALLOWED_PROVIDERS ?? '*',
      maxAttempts: int(env, 'CONSUMER_MAX_ATTEMPTS', 5),
      concurrency: int(env, 'CONSUMER_CONCURRENCY', 10),
      waitTimeSeconds: int(env, 'CONSUMER_WAIT_TIME_SECONDS', 10),
      visibilityTimeoutSeconds: int(env, 'CONSUMER_VISIBILITY_TIMEOUT_SECONDS', 30),
      retryBaseDelaySeconds: int(env, 'CONSUMER_RETRY_BASE_DELAY_SECONDS', 2),
      retryMaxDelaySeconds: int(env, 'CONSUMER_RETRY_MAX_DELAY_SECONDS', 60),
    },
    outbox: {
      batchSize: int(env, 'OUTBOX_BATCH_SIZE', 50),
      intervalMs: int(env, 'OUTBOX_INTERVAL_MS', 500),
    },
    references: {
      batchSize: int(env, 'REFERENCE_BATCH_SIZE', 50),
      intervalMs: int(env, 'REFERENCE_INTERVAL_MS', 1_000),
      leaseMs: int(env, 'REFERENCE_LEASE_MS', 30_000),
      maxAttempts: int(env, 'REFERENCE_MAX_ATTEMPTS', 12),
      baseDelayMs: int(env, 'REFERENCE_BASE_DELAY_MS', 1_000),
      maxDelayMs: int(env, 'REFERENCE_MAX_DELAY_MS', 300_000),
    },
    shutdownTimeoutMs: int(env, 'SHUTDOWN_TIMEOUT_MS', 20_000),
  };
}
