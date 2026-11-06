import { TRUSTED_INTERNAL_PRINCIPAL } from '../../src/application/provider-access';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { ResolvePendingReferences } from '../../src/application/wagering/resolve-pending-references';
import { parseWagerPayload } from '../../src/application/wagering/wager-payload';
import { WagerProcessor } from '../../src/application/wagering/wager-processor';
import type { Container } from '../../src/container';
import { newId } from '../../src/domain/shared/id';
import { Money } from '../../src/domain/shared/money';
import { ReferenceRetryPolicy } from '../../src/domain/wagering/reference-retry-policy';
import { WagerTransactionStatus } from '../../src/domain/wagering/wager-transaction-status';
import { createTestContainer } from '../support/app';
import { assertLedgerMatchesBalance, keyFor, wagerBody } from '../support/fixtures';

let container: Container;

beforeAll(async () => {
  container = await createTestContainer({}, { REFERENCE_BASE_DELAY_MS: '0', REFERENCE_MAX_DELAY_MS: '0' });
});

afterAll(async () => {
  await container.close();
});

async function openWallet(amount = '100.00') {
  const view = await container.openWallet.execute({
    playerId: newId(),
    initialBalance: Money.from({ amount, currency: 'BRL' }),
    correlationId: newId(),
  });
  return view;
}

function submit(body: ReturnType<typeof wagerBody>) {
  return container.submitWager.execute({
    idempotencyKey: keyFor(body),
    payload: parseWagerPayload(body),
    correlationId: newId(),
    source: 'http',
    principal: TRUSTED_INTERNAL_PRINCIPAL,
  });
}

async function transaction(id: string) {
  return container.queries.getTransaction(id);
}

async function resolveAll(resolver = container.resolvePendingReferences) {
  for (let i = 0; i < 20; i++) {
    const summary = await resolver.runOnce();
    if (summary.claimed === 0) return;
  }
}

describe('out-of-order references', () => {
  it('applies a REFUND that arrived before its BET once the BET is processed', async () => {
    const wallet = await openWallet('100.00');
    const bet = wagerBody(wallet, 'BET', '30.00');
    const refund = wagerBody(wallet, 'REFUND', '30.00', { referenceExternalTransactionId: bet.externalTransactionId });

    const pending = await submit(refund);
    expect(pending.status).toBe(WagerTransactionStatus.PendingReference);

    const betOutcome = await submit(bet);
    expect(betOutcome.balance.amount).toBe('70.00');

    await resolveAll();
    const resolved = await transaction(pending.transactionId);
    expect(resolved.status).toBe('PROCESSED');
    expect(resolved.referenceTransactionId).toBe(betOutcome.transactionId);
    expect((await container.queries.getWallet(wallet.id)).balance.amount).toBe('100.00');

    const replay = await submit(refund);
    expect(replay).toMatchObject({ status: 'PROCESSED', idempotentReplay: true, balance: { amount: '100.00' } });
    await assertLedgerMatchesBalance(container.orm, wallet.id);
  });

  it('applies a ROLLBACK delivered before the WIN it reverses', async () => {
    const wallet = await openWallet('10.00');
    const win = wagerBody(wallet, 'WIN', '50.00');
    const rollback = wagerBody(wallet, 'ROLLBACK', '50.00', { referenceExternalTransactionId: win.externalTransactionId });

    const pending = await submit(rollback);
    expect(pending.status).toBe(WagerTransactionStatus.PendingReference);
    await submit(win);
    await resolveAll();

    expect((await transaction(pending.transactionId)).status).toBe('PROCESSED');
    expect((await container.queries.getWallet(wallet.id)).balance.amount).toBe('10.00');
    await assertLedgerMatchesBalance(container.orm, wallet.id);
  });

  it('rejects with REFERENCE_NOT_FOUND after exhausting attempts and publishes the rejection', async () => {
    const wallet = await openWallet('100.00');
    const refund = wagerBody(wallet, 'REFUND', '10.00', { referenceExternalTransactionId: `ghost-${newId()}` });
    const pending = await submit(refund);

    const limited = new ResolvePendingReferences(
      container.unitOfWork,
      new WagerProcessor(ReferenceRetryPolicy.of({ maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 0 })),
      container.clock,
      container.metrics,
      container.logger,
      { batchSize: 100, leaseMs: 0 },
    );
    await resolveAll(limited);

    const rejected = await transaction(pending.transactionId);
    expect(rejected.status).toBe('REJECTED');
    expect(rejected.failureCode).toBe('REFERENCE_NOT_FOUND');
    expect(rejected.referenceAttempts).toBe(2);

    const events = await container.orm.em.fork().execute<Array<{ event_type: string }>>(
      `SELECT event_type FROM outbox_messages WHERE aggregate_id = ? ORDER BY sequence`,
      [pending.transactionId],
    );
    expect(events.map((event) => event.event_type)).toEqual([
      'WagerTransactionPendingReference',
      'WagerTransactionRejected',
    ]);
    expect((await container.queries.getWallet(wallet.id)).balance.amount).toBe('100.00');
  });

  it('rejects a pending REFUND whose BET was rejected', async () => {
    const wallet = await openWallet('5.00');
    const bet = wagerBody(wallet, 'BET', '30.00');
    const refund = wagerBody(wallet, 'REFUND', '30.00', { referenceExternalTransactionId: bet.externalTransactionId });
    const pending = await submit(refund);
    await submit(bet);
    await resolveAll();

    const resolved = await transaction(pending.transactionId);
    expect(resolved.status).toBe('REJECTED');
    expect(resolved.failureCode).toBe('REFERENCE_NOT_PROCESSED');
    expect((await container.queries.getWallet(wallet.id)).balance.amount).toBe('5.00');
  });

  it('lets concurrent resolvers apply a pending transaction exactly once', async () => {
    const wallet = await openWallet('100.00');
    const pendingIds: string[] = [];
    for (let i = 0; i < 10; i++) {
      const bet = wagerBody(wallet, 'BET', '1.00');
      const refund = wagerBody(wallet, 'REFUND', '1.00', { referenceExternalTransactionId: bet.externalTransactionId });
      pendingIds.push((await submit(refund)).transactionId);
      await submit(bet);
    }

    const resolvers = Array.from(
      { length: 4 },
      () =>
        new ResolvePendingReferences(
          container.unitOfWork,
          container.processor,
          container.clock,
          container.metrics,
          container.logger,
          { batchSize: 3, leaseMs: 30_000 },
        ),
    );
    await Promise.all(resolvers.map((resolver) => resolveAll(resolver)));

    for (const id of pendingIds) {
      expect((await transaction(id)).status).toBe('PROCESSED');
    }
    expect((await container.queries.getWallet(wallet.id)).balance.amount).toBe('100.00');
    await assertLedgerMatchesBalance(container.orm, wallet.id);
  });
});
