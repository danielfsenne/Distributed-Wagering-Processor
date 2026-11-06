import type { INestApplication } from '@nestjs/common';
import { type AppConfig, loadConfig } from '../../src/config';
import { type Container, type ContainerOverrides, createContainer } from '../../src/container';
import { PinoAppLogger, createRootLogger } from '../../src/infrastructure/observability/logger';
import { PrometheusMetrics } from '../../src/infrastructure/observability/prometheus-metrics';
import { createHttpApp } from '../../src/interfaces/http/http-app';
import { TEST_DATABASE_URL, ensureMigrated } from './database';

export function testConfig(overrides: Partial<Record<string, string>> = {}): AppConfig {
  return loadConfig(
    {
      DATABASE_URL: TEST_DATABASE_URL,
      SQS_TRANSACTIONS_QUEUE: 'test-wager-transactions.fifo',
      SQS_DLQ_QUEUE: 'test-wager-transactions-dlq.fifo',
      SQS_EVENTS_QUEUE: 'test-wagering-events.fifo',
      LOG_LEVEL: 'silent',
      ...overrides,
    },
    'all',
  );
}

export async function createTestContainer(
  overrides: ContainerOverrides = {},
  env: Partial<Record<string, string>> = {},
): Promise<Container> {
  await ensureMigrated();
  return createContainer(testConfig(env), {
    logger: new PinoAppLogger(createRootLogger(process.env.TEST_LOG_LEVEL ?? 'silent')),
    metrics: new PrometheusMetrics(false),
    ...overrides,
  });
}

export interface TestHttpApp {
  container: Container;
  app: INestApplication;
  baseUrl: string;
  close(): Promise<void>;
}

export async function startTestHttpApp(container?: Container): Promise<TestHttpApp> {
  const resolved = container ?? (await createTestContainer());
  const app = await createHttpApp(resolved);
  await app.listen(0);
  const address = app.getHttpServer().address() as { port: number };
  return {
    container: resolved,
    app,
    baseUrl: `http://127.0.0.1:${address.port}`,
    async close() {
      await app.close();
      if (!container) await resolved.close();
    },
  };
}
