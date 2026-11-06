import { fileURLToPath } from 'node:url';
import { type Subprocess, spawn } from 'bun';
import { TEST_DATABASE_URL } from './database';

export interface AppProcess {
  name: string;
  process: Subprocess<'ignore', 'pipe', 'pipe'>;
  port?: number;
  baseUrl?: string;
  logs: string[];
  stop(signal?: NodeJS.Signals): Promise<number | null>;
}

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

async function collect(stream: ReadableStream<Uint8Array>, sink: string[]): Promise<void> {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true });
    let index = buffer.indexOf('\n');
    while (index >= 0) {
      sink.push(buffer.slice(0, index));
      buffer = buffer.slice(index + 1);
      index = buffer.indexOf('\n');
    }
  }
  if (buffer) sink.push(buffer);
}

let nextPort = 3400 + Math.floor(Math.random() * 400);

export async function spawnApp(
  name: string,
  mode: 'api' | 'worker' | 'all',
  env: Record<string, string> = {},
): Promise<AppProcess> {
  const port = nextPort++;
  const logs: string[] = [];
  const child = spawn({
    cmd: [process.execPath, 'src/main.ts', mode],
    cwd: ROOT,
    env: {
      ...process.env,
      DATABASE_URL: TEST_DATABASE_URL,
      PORT: String(port),
      OPS_PORT: String(port),
      LOG_LEVEL: 'info',
      DB_POOL_MAX: '10',
      SQS_TRANSACTIONS_QUEUE: 'test-wager-transactions.fifo',
      SQS_DLQ_QUEUE: 'test-wager-transactions-dlq.fifo',
      SQS_EVENTS_QUEUE: 'test-wagering-events.fifo',
      CONSUMER_WAIT_TIME_SECONDS: '1',
      OUTBOX_INTERVAL_MS: '100',
      REFERENCE_INTERVAL_MS: '200',
      REFERENCE_BASE_DELAY_MS: '100',
      REFERENCE_MAX_DELAY_MS: '500',
      SHUTDOWN_TIMEOUT_MS: '10000',
      ...env,
    },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  void collect(child.stdout, logs);
  void collect(child.stderr, logs);

  const app: AppProcess = {
    name,
    process: child,
    logs,
    ...(mode !== 'worker' ? { port, baseUrl: `http://127.0.0.1:${port}` } : {}),
    async stop(signal: NodeJS.Signals = 'SIGTERM') {
      if (child.exitCode !== null || child.signalCode !== null) return child.exitCode;
      child.kill(signal);
      return child.exited;
    },
  };

  const readyLine = mode === 'worker' ? '"msg":"worker started"' : '"msg":"http server listening"';
  const deadline = Date.now() + 30_000;
  while (!logs.some((line) => line.includes(readyLine))) {
    if (child.exitCode !== null) {
      throw new Error(`${name} exited during startup:\n${logs.join('\n')}`);
    }
    if (Date.now() > deadline) {
      child.kill('SIGKILL');
      throw new Error(`${name} did not become ready:\n${logs.join('\n')}`);
    }
    await Bun.sleep(100);
  }
  return app;
}

export async function stopAll(apps: AppProcess[], signal: NodeJS.Signals = 'SIGTERM'): Promise<void> {
  await Promise.all(apps.map((app) => app.stop(signal)));
}
