import { mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { MikroORM } from '@mikro-orm/postgresql';
import { newId } from '../../src/domain/shared/id';
import { createOrmConfig } from '../../src/infrastructure/persistence/mikro-orm.config';

interface Settings {
  baseUrls: string[];
  databaseUrl: string;
  durationSeconds: number;
  concurrency: number;
  wallets: number;
  scenario: 'spread' | 'hot' | 'all';
}

interface Sample {
  latencyMs: number;
  status: number;
  outcome: string;
}

interface PlacedBet {
  externalTransactionId: string;
  roundId: string;
}

interface Wallet {
  id: string;
  playerId: string;
}

interface ScenarioResult {
  scenario: string;
  instances: number;
  requests: number;
  durationSeconds: number;
  throughputRps: number;
  latencyMs: { p50: number; p95: number; p99: number; max: number; mean: number };
  statuses: Record<string, number>;
  outcomes: Record<string, number>;
  errorRate: number;
  lockConflicts: number;
  retries: number;
  outboxLagSeconds: { max: number; p95: number; final: number };
  outboxDrainSeconds: number;
  reconciliation: { wallets: number; consistent: number; inconsistent: number };
}

const settings: Settings = {
  baseUrls: (process.env.BASE_URLS ?? process.env.BASE_URL ?? 'http://localhost:3000')
    .split(',')
    .map((url) => url.trim())
    .filter(Boolean),
  databaseUrl: process.env.DATABASE_URL ?? 'postgres://wagering:wagering@localhost:55432/wagering',
  durationSeconds: Number(process.env.DURATION_SECONDS ?? 20),
  concurrency: Number(process.env.CONCURRENCY ?? 32),
  wallets: Number(process.env.WALLETS ?? 200),
  scenario: (process.env.SCENARIO as Settings['scenario']) ?? 'all',
};

let requestCounter = 0;
const nextBaseUrl = () => settings.baseUrls[requestCounter++ % settings.baseUrls.length]!;

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return Number(sorted[Math.max(0, index)]!.toFixed(2));
}

async function json(
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
  baseUrl = nextBaseUrl(),
) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json().catch(() => ({}))) as Record<string, any> };
}

async function scrapeCounter(name: string): Promise<number> {
  let total = 0;
  for (const baseUrl of settings.baseUrls) {
    const text = await fetch(`${baseUrl}/metrics`).then((response) => response.text());
    total += text
      .split('\n')
      .filter((line) => line.startsWith(name))
      .reduce((sum, line) => sum + Number(line.split(' ').at(-1) ?? 0), 0);
  }
  return total;
}

async function openWallets(count: number, amount: string): Promise<Wallet[]> {
  const wallets: Wallet[] = [];
  for (let i = 0; i < count; i += 20) {
    const batch = await Promise.all(
      Array.from({ length: Math.min(20, count - i) }, async () => {
        const response = await json('POST', '/wallets', {
          playerId: newId(),
          initialBalance: { amount, currency: 'BRL' },
        });
        if (response.status !== 201) throw new Error(`could not open wallet: ${response.status}`);
        return response.body as Wallet;
      }),
    );
    wallets.push(...batch);
  }
  return wallets;
}

function operation(wallet: Wallet, placedBets: Map<string, PlacedBet[]>) {
  const roll = Math.random();
  const bets = placedBets.get(wallet.id) ?? [];
  const common = {
    providerId: 'load-provider',
    externalTransactionId: `load-${newId()}`,
    playerId: wallet.playerId,
    walletId: wallet.id,
    gameId: 'fortune-chimp',
  };
  if (roll < 0.6 || bets.length === 0) {
    const roundId = `round-${newId()}`;
    bets.push({ externalTransactionId: common.externalTransactionId, roundId });
    if (bets.length > 50) bets.shift();
    placedBets.set(wallet.id, bets);
    return { ...common, roundId, kind: 'BET', money: { amount: '1.00', currency: 'BRL' } };
  }
  const index = Math.floor(Math.random() * bets.length);
  const bet = bets[index]!;
  const reference = { roundId: bet.roundId, referenceExternalTransactionId: bet.externalTransactionId };
  if (roll < 0.85) {
    return { ...common, ...reference, kind: 'WIN', money: { amount: '1.50', currency: 'BRL' } };
  }
  if (roll < 0.95) {
    return { ...common, ...reference, kind: 'LOSS', money: { amount: '0.00', currency: 'BRL' } };
  }
  bets.splice(index, 1);
  return { ...common, ...reference, kind: 'REFUND', money: { amount: '1.00', currency: 'BRL' } };
}

async function sampleOutboxLag(orm: MikroORM): Promise<number> {
  const [row] = await orm.em.fork().execute<Array<{ lag: string | null }>>(
    `SELECT EXTRACT(EPOCH FROM (now() - MIN(occurred_at)))::text AS lag
       FROM outbox_messages WHERE published_at IS NULL`,
  );
  return row?.lag ? Math.max(0, Number(row.lag)) : 0;
}

async function runScenario(name: string, orm: MikroORM, wallets: Wallet[]): Promise<ScenarioResult> {
  const samples: Sample[] = [];
  const placedBets = new Map<string, PlacedBet[]>();
  const lagSamples: number[] = [];
  const conflictsBefore = await scrapeCounter('wagering_lock_conflicts_total');
  const retriesBefore = await scrapeCounter('wagering_retries_total');

  const deadline = performance.now() + settings.durationSeconds * 1000;
  const startedAt = performance.now();
  let sampling = true;
  const sampler = (async () => {
    while (sampling) {
      lagSamples.push(await sampleOutboxLag(orm));
      await Bun.sleep(250);
    }
  })();

  await Promise.all(
    Array.from({ length: settings.concurrency }, async () => {
      while (performance.now() < deadline) {
        const wallet = wallets[Math.floor(Math.random() * wallets.length)]!;
        const body = operation(wallet, placedBets);
        const sentAt = performance.now();
        try {
          const response = await json('POST', '/wagering/transactions', body, {
            'Idempotency-Key': `${body.providerId}:${body.externalTransactionId}`,
          });
          samples.push({
            latencyMs: performance.now() - sentAt,
            status: response.status,
            outcome: response.body.failureCode ?? response.body.status ?? response.body.error?.code ?? 'UNKNOWN',
          });
        } catch {
          samples.push({ latencyMs: performance.now() - sentAt, status: 0, outcome: 'NETWORK_ERROR' });
        }
      }
    }),
  );
  const elapsedSeconds = (performance.now() - startedAt) / 1000;

  const drainStartedAt = performance.now();
  while ((await sampleOutboxLag(orm)) > 0 && performance.now() - drainStartedAt < 60_000) {
    await Bun.sleep(200);
  }
  const outboxDrainSeconds = (performance.now() - drainStartedAt) / 1000;
  sampling = false;
  await sampler;

  let consistent = 0;
  let inconsistent = 0;
  for (const wallet of wallets) {
    const report = await json('POST', `/wallets/${wallet.id}/reconciliation`);
    if (report.body.consistent === true) consistent++;
    else inconsistent++;
  }

  const latencies = samples.map((sample) => sample.latencyMs).sort((a, b) => a - b);
  const count = (key: (sample: Sample) => string) =>
    samples.reduce<Record<string, number>>((acc, sample) => {
      acc[key(sample)] = (acc[key(sample)] ?? 0) + 1;
      return acc;
    }, {});
  const errors = samples.filter((sample) => sample.status === 0 || sample.status >= 500).length;
  const sortedLag = [...lagSamples].sort((a, b) => a - b);

  return {
    scenario: name,
    instances: settings.baseUrls.length,
    requests: samples.length,
    durationSeconds: Number(elapsedSeconds.toFixed(2)),
    throughputRps: Number((samples.length / elapsedSeconds).toFixed(1)),
    latencyMs: {
      p50: percentile(latencies, 50),
      p95: percentile(latencies, 95),
      p99: percentile(latencies, 99),
      max: Number((latencies.at(-1) ?? 0).toFixed(2)),
      mean: Number((latencies.reduce((sum, value) => sum + value, 0) / Math.max(1, latencies.length)).toFixed(2)),
    },
    statuses: count((sample) => String(sample.status)),
    outcomes: count((sample) => sample.outcome),
    errorRate: Number((errors / Math.max(1, samples.length)).toFixed(4)),
    lockConflicts: (await scrapeCounter('wagering_lock_conflicts_total')) - conflictsBefore,
    retries: (await scrapeCounter('wagering_retries_total')) - retriesBefore,
    outboxLagSeconds: {
      max: Number((sortedLag.at(-1) ?? 0).toFixed(2)),
      p95: Number(percentile(sortedLag, 95).toFixed(2)),
      final: Number((await sampleOutboxLag(orm)).toFixed(2)),
    },
    outboxDrainSeconds: Number(outboxDrainSeconds.toFixed(2)),
    reconciliation: { wallets: wallets.length, consistent, inconsistent },
  };
}

async function main() {
  for (const baseUrl of settings.baseUrls) {
    const health = await json('GET', '/health/ready', undefined, {}, baseUrl).catch(() => ({ status: 0, body: {} }));
    if (health.status !== 200) {
      console.error(`API at ${baseUrl} is not ready. Start the stack with: docker compose up -d --build`);
      process.exit(1);
    }
  }
  const orm = await MikroORM.init(createOrmConfig({ databaseUrl: settings.databaseUrl, poolMax: 2 }));
  const results: ScenarioResult[] = [];
  try {
    if (settings.scenario === 'spread' || settings.scenario === 'all') {
      const wallets = await openWallets(settings.wallets, '100000.00');
      results.push(await runScenario(`spread (${settings.wallets} wallets)`, orm, wallets));
    }
    if (settings.scenario === 'hot' || settings.scenario === 'all') {
      const wallets = await openWallets(1, '100000.00');
      results.push(await runScenario('hot wallet (1 wallet)', orm, wallets));
    }
  } finally {
    await orm.close(true);
  }

  const report = {
    timestamp: new Date().toISOString(),
    environment: {
      host: `${os.type()} ${os.release()} (${os.arch()})`,
      cpus: `${os.cpus().length}x ${os.cpus()[0]?.model ?? 'unknown'}`,
      memoryGb: Number((os.totalmem() / 1024 ** 3).toFixed(1)),
      bun: Bun.version,
    },
    settings,
    results,
  };
  mkdirSync('load-test-results', { recursive: true });
  const file = `load-test-results/load-${report.timestamp.replace(/[:.]/g, '-')}.json`;
  writeFileSync(file, JSON.stringify(report, null, 2));

  for (const result of results) {
    console.log(`\n== ${result.scenario} via ${result.instances} instance(s)`);
    console.log(`requests        ${result.requests} in ${result.durationSeconds}s (${result.throughputRps} req/s)`);
    console.log(
      `latency ms      p50=${result.latencyMs.p50} p95=${result.latencyMs.p95} p99=${result.latencyMs.p99} max=${result.latencyMs.max}`,
    );
    console.log(`statuses        ${JSON.stringify(result.statuses)}`);
    console.log(`outcomes        ${JSON.stringify(result.outcomes)}`);
    console.log(`error rate      ${(result.errorRate * 100).toFixed(2)}%`);
    console.log(`lock conflicts  ${result.lockConflicts}   retries ${result.retries}`);
    console.log(
      `outbox lag s    max=${result.outboxLagSeconds.max} p95=${result.outboxLagSeconds.p95} drain=${result.outboxDrainSeconds}s`,
    );
    console.log(`reconciliation  ${result.reconciliation.consistent}/${result.reconciliation.wallets} consistent`);
  }
  console.log(`\nreport written to ${file}`);
}

await main();
