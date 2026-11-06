import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { type AppMode, loadConfig } from './config';
import { createContainer } from './container';
import { createHttpApp } from './interfaces/http/http-app';
import { type Worker, startWorker } from './worker';

async function main(): Promise<void> {
  const mode = (process.argv[2] as AppMode | undefined) ?? undefined;
  const config = loadConfig(process.env, mode);
  const container = await createContainer(config);
  const logger = container.logger;

  let http: INestApplication | undefined;
  if (config.mode === 'api' || config.mode === 'all') {
    http = await createHttpApp(container);
    await http.listen(config.port);
    logger.info('http server listening', { port: config.port });
  }

  let worker: Worker | undefined;
  if (config.mode === 'worker' || config.mode === 'all') {
    worker = startWorker(container);
  }

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('shutdown requested', { signal });
    const deadline = setTimeout(() => {
      logger.error('shutdown timed out, forcing exit');
      process.exit(1);
    }, config.shutdownTimeoutMs);
    deadline.unref();
    try {
      await http?.close();
      await worker?.stop(Math.max(1_000, config.shutdownTimeoutMs - 5_000));
      await container.close();
      logger.info('shutdown complete');
      process.exit(0);
    } catch (error) {
      logger.error('shutdown failed', { error: (error as Error).message });
      process.exit(1);
    }
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((error) => {
  console.error(JSON.stringify({ level: 'fatal', msg: 'startup failed', error: String(error?.stack ?? error) }));
  process.exit(1);
});
