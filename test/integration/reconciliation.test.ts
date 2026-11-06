import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { LogFields, Logger } from '../../src/application/ports';
import { ReconcileWallet } from '../../src/application/wallets/reconcile-wallet';
import type { Container } from '../../src/container';
import { newId } from '../../src/domain/shared/id';
import { Money } from '../../src/domain/shared/money';
import { PrometheusMetrics } from '../../src/infrastructure/observability/prometheus-metrics';
import { createTestContainer } from '../support/app';

let container: Container;

beforeAll(async () => {
  container = await createTestContainer();
});

afterAll(async () => {
  await container.close();
});

class RecordingLogger implements Logger {
  readonly entries: Array<{ level: string; message: string; fields: LogFields }> = [];

  debug(message: string, fields: LogFields = {}) {
    this.entries.push({ level: 'debug', message, fields });
  }

  info(message: string, fields: LogFields = {}) {
    this.entries.push({ level: 'info', message, fields });
  }

  warn(message: string, fields: LogFields = {}) {
    this.entries.push({ level: 'warn', message, fields });
  }

  error(message: string, fields: LogFields = {}) {
    this.entries.push({ level: 'error', message, fields });
  }
}

async function openWallet(amount: string) {
  return container.openWallet.execute({
    playerId: newId(),
    initialBalance: Money.from({ amount, currency: 'BRL' }),
    correlationId: newId(),
  });
}

async function corruptStoredBalance(walletId: string, balance: string) {
  await container.orm.em.fork().transactional(async (em) => {
    await em.execute(`SET LOCAL session_replication_role = replica`);
    await em.execute(`UPDATE wallets SET balance = ? WHERE id = ?`, [balance, walletId]);
  });
}

async function divergenceCount(metrics: PrometheusMetrics): Promise<number> {
  const { body } = await metrics.render();
  const line = body.split('\n').find((row) => row.startsWith('wagering_reconciliation_divergences_total '));
  return Number(line?.split(' ').at(-1) ?? 0);
}

describe('reconciliation', () => {
  it('reports a consistent wallet without touching metrics', async () => {
    const wallet = await openWallet('100.00');
    const metrics = new PrometheusMetrics(false);
    const logger = new RecordingLogger();
    const report = await new ReconcileWallet(container.unitOfWork, metrics, logger).execute(wallet.id);

    expect(report).toEqual({
      walletId: wallet.id,
      storedBalance: { amount: '100.00', currency: 'BRL' },
      calculatedBalance: { amount: '100.00', currency: 'BRL' },
      difference: { amount: '0.00', currency: 'BRL' },
      consistent: true,
      checkedEntries: 1,
    });
    expect(await divergenceCount(metrics)).toBe(0);
    expect(logger.entries.some((entry) => entry.level === 'error')).toBe(false);
  });

  it('flags, logs and counts a divergence without correcting it', async () => {
    const wallet = await openWallet('100.00');
    await corruptStoredBalance(wallet.id, '137.50');

    const metrics = new PrometheusMetrics(false);
    const logger = new RecordingLogger();
    const report = await new ReconcileWallet(container.unitOfWork, metrics, logger).execute(wallet.id);

    expect(report).toEqual({
      walletId: wallet.id,
      storedBalance: { amount: '137.50', currency: 'BRL' },
      calculatedBalance: { amount: '100.00', currency: 'BRL' },
      difference: { amount: '37.50', currency: 'BRL' },
      consistent: false,
      checkedEntries: 1,
    });
    expect(await divergenceCount(metrics)).toBe(1);

    const logged = logger.entries.find((entry) => entry.message === 'wallet reconciliation divergence');
    expect(logged?.level).toBe('error');
    expect(logged?.fields).toEqual({ walletId: wallet.id, difference: '37.50', checkedEntries: 1 });

    const after = await container.queries.getWallet(wallet.id);
    expect(after.balance.amount).toBe('137.50');
    expect(after.version).toBe(1);
  });

  it('reports a negative difference when the stored balance is below the ledger', async () => {
    const wallet = await openWallet('100.00');
    await corruptStoredBalance(wallet.id, '60.00');

    const report = await new ReconcileWallet(
      container.unitOfWork,
      new PrometheusMetrics(false),
      new RecordingLogger(),
    ).execute(wallet.id);

    expect(report.consistent).toBe(false);
    expect(report.difference).toEqual({ amount: '-40.00', currency: 'BRL' });
  });

  it('surfaces the divergence through the HTTP endpoint', async () => {
    const { startTestHttpApp } = await import('../support/app');
    const http = await startTestHttpApp(container);
    try {
      const wallet = await openWallet('50.00');
      await corruptStoredBalance(wallet.id, '50.01');
      const response = await fetch(`${http.baseUrl}/wallets/${wallet.id}/reconciliation`, { method: 'POST' });
      expect(response.status).toBe(200);
      const body = (await response.json()) as { consistent: boolean; difference: { amount: string } };
      expect(body.consistent).toBe(false);
      expect(body.difference.amount).toBe('0.01');

      const metrics = await fetch(`${http.baseUrl}/metrics`).then((res) => res.text());
      expect(metrics).toMatch(/wagering_reconciliation_divergences_total [1-9]/);
    } finally {
      await http.close();
    }
  });
});
