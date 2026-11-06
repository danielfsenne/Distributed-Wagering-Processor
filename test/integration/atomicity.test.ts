import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { TransactionScope, UnitOfWork } from '../../src/application/ports';
import { SubmitWagerTransaction } from '../../src/application/wagering/submit-wager-transaction';
import { parseWagerPayload } from '../../src/application/wagering/wager-payload';
import type { Container } from '../../src/container';
import { newId } from '../../src/domain/shared/id';
import { Money } from '../../src/domain/shared/money';
import { WagerTransactionStatus } from '../../src/domain/wagering/wager-transaction-status';
import { createTestContainer } from '../support/app';
import { assertLedgerMatchesBalance, countRows, keyFor, wagerBody } from '../support/fixtures';

let container: Container;

beforeAll(async () => {
  container = await createTestContainer();
});

afterAll(async () => {
  await container.close();
});

async function openWallet(amount = '100.00') {
  return container.openWallet.execute({
    playerId: newId(),
    initialBalance: Money.from({ amount, currency: 'BRL' }),
    correlationId: newId(),
  });
}

class FailingUnitOfWork implements UnitOfWork {
  constructor(
    private readonly inner: UnitOfWork,
    private readonly sabotage: (scope: TransactionScope) => TransactionScope,
  ) {}

  run<T>(work: (scope: TransactionScope) => Promise<T>): Promise<T> {
    return this.inner.run((scope) => work(this.sabotage(scope)));
  }

  read<T>(work: (scope: TransactionScope) => Promise<T>): Promise<T> {
    return this.inner.read(work);
  }

  ping(): Promise<void> {
    return this.inner.ping();
  }
}

function submitterWith(unitOfWork: UnitOfWork) {
  return new SubmitWagerTransaction(
    unitOfWork,
    container.processor,
    container.clock,
    container.metrics,
    container.logger,
  );
}

async function rowsFor(walletId: string, transactionKey: string) {
  const orm = container.orm;
  return {
    transactions: await countRows(orm, 'SELECT COUNT(*) AS count FROM wager_transactions WHERE idempotency_key = ?', [
      transactionKey,
    ]),
    ledger: await countRows(orm, 'SELECT COUNT(*) AS count FROM wallet_ledger_entries WHERE wallet_id = ?', [walletId]),
    outbox: await countRows(
      orm,
      `SELECT COUNT(*) AS count FROM outbox_messages o
         JOIN wager_transactions t ON t.id::text = o.aggregate_id
        WHERE t.idempotency_key = ?`,
      [transactionKey],
    ),
  };
}

describe('atomicity of wallet, ledger, inbox and outbox', () => {
  it('commits transaction, ledger entry, balance and events together', async () => {
    const wallet = await openWallet('100.00');
    const body = wagerBody(wallet, 'BET', '30.00');
    const outcome = await container.submitWager.execute({
      idempotencyKey: keyFor(body),
      payload: parseWagerPayload(body),
      correlationId: 'corr-atomic',
      source: 'http',
    });

    expect(outcome.status).toBe(WagerTransactionStatus.Processed);
    expect(await rowsFor(wallet.id, keyFor(body))).toEqual({ transactions: 1, ledger: 2, outbox: 1 });
    const events = await container.orm.em.fork().execute<Array<{ event_type: string; payload: { correlationId: string } }>>(
      `SELECT event_type, payload FROM outbox_messages
        WHERE payload->'data'->>'transactionId' = ? ORDER BY sequence`,
      [outcome.transactionId],
    );
    expect(events.map((event) => event.event_type)).toEqual(['WagerTransactionProcessed', 'WalletBalanceChanged']);
    expect(events.every((event) => event.payload.correlationId === 'corr-atomic')).toBe(true);
    await assertLedgerMatchesBalance(container.orm, wallet.id);
  });

  it('rolls everything back when the outbox write fails', async () => {
    const wallet = await openWallet('100.00');
    const body = wagerBody(wallet, 'BET', '30.00');
    const failing = submitterWith(
      new FailingUnitOfWork(container.unitOfWork, (scope) => ({
        ...scope,
        outbox: {
          ...scope.outbox,
          enqueue: async () => {
            throw new Error('simulated crash before outbox write');
          },
        },
      })),
    );

    await expect(
      failing.execute({
        idempotencyKey: keyFor(body),
        payload: parseWagerPayload(body),
        correlationId: newId(),
        source: 'http',
      }),
    ).rejects.toThrow('simulated crash');

    expect(await rowsFor(wallet.id, keyFor(body))).toEqual({ transactions: 0, ledger: 1, outbox: 0 });
    const stored = await container.queries.getWallet(wallet.id);
    expect(stored.balance.amount).toBe('100.00');
    expect(stored.version).toBe(1);
  });

  it('rolls everything back when the process dies after the ledger write', async () => {
    const wallet = await openWallet('100.00');
    const body = wagerBody(wallet, 'BET', '30.00');
    const failing = submitterWith(
      new FailingUnitOfWork(container.unitOfWork, (scope) => ({
        ...scope,
        wallets: {
          ...scope.wallets,
          lockById: scope.wallets.lockById.bind(scope.wallets),
          saveBalance: async () => {
            throw new Error('simulated crash after ledger write');
          },
        },
      })),
    );

    await expect(
      failing.execute({
        idempotencyKey: keyFor(body),
        payload: parseWagerPayload(body),
        correlationId: newId(),
        source: 'http',
      }),
    ).rejects.toThrow('simulated crash');

    expect(await rowsFor(wallet.id, keyFor(body))).toEqual({ transactions: 0, ledger: 1, outbox: 0 });
    await assertLedgerMatchesBalance(container.orm, wallet.id);

    const retried = await container.submitWager.execute({
      idempotencyKey: keyFor(body),
      payload: parseWagerPayload(body),
      correlationId: newId(),
      source: 'http',
    });
    expect(retried).toMatchObject({ status: 'PROCESSED', idempotentReplay: false });
    expect(retried.balance.amount).toBe('70.00');
  });

  it('records the inbox entry in the same transaction and dedupes redelivery', async () => {
    const wallet = await openWallet('100.00');
    const body = wagerBody(wallet, 'BET', '10.00');
    const messageId = `msg-${newId()}`;
    const command = {
      idempotencyKey: keyFor(body),
      payload: parseWagerPayload(body),
      correlationId: newId(),
      source: 'sqs' as const,
      inbox: { consumerName: 'atomicity-test', messageId, messageHash: 'f'.repeat(64) },
    };

    const first = await container.submitWager.execute(command);
    const redelivered = await container.submitWager.execute(command);

    expect(first.idempotentReplay).toBe(false);
    expect(redelivered).toEqual({ ...first, idempotentReplay: true });
    const [inbox] = await container.orm.em.fork().execute<Array<{ transaction_id: string; processed_at: Date | null }>>(
      'SELECT transaction_id, processed_at FROM inbox_messages WHERE consumer_name = ? AND message_id = ?',
      ['atomicity-test', messageId],
    );
    expect(inbox!.transaction_id).toBe(first.transactionId);
    expect(inbox!.processed_at).not.toBeNull();
    expect(
      await countRows(container.orm, 'SELECT COUNT(*) AS count FROM wallet_ledger_entries WHERE transaction_id = ?', [
        first.transactionId,
      ]),
    ).toBe(1);
  });

  it('does not keep an inbox entry when processing fails', async () => {
    const wallet = await openWallet('100.00');
    const body = wagerBody(wallet, 'BET', '10.00');
    const messageId = `msg-${newId()}`;
    const failing = submitterWith(
      new FailingUnitOfWork(container.unitOfWork, (scope) => ({
        ...scope,
        outbox: {
          ...scope.outbox,
          enqueue: async () => {
            throw new Error('simulated failure');
          },
        },
      })),
    );
    await expect(
      failing.execute({
        idempotencyKey: keyFor(body),
        payload: parseWagerPayload(body),
        correlationId: newId(),
        source: 'sqs',
        inbox: { consumerName: 'atomicity-test', messageId, messageHash: 'f'.repeat(64) },
      }),
    ).rejects.toThrow();
    expect(
      await countRows(container.orm, 'SELECT COUNT(*) AS count FROM inbox_messages WHERE message_id = ?', [messageId]),
    ).toBe(0);
  });

  it('opens a wallet atomically with its OPENING transaction and ledger entry', async () => {
    const wallet = await openWallet('250.00');
    const [opening] = await container.orm.em.fork().execute<Array<{ kind: string; status: string; provider_id: string }>>(
      `SELECT kind, status, provider_id FROM wager_transactions WHERE wallet_id = ?`,
      [wallet.id],
    );
    expect(opening).toEqual({ kind: 'OPENING', status: 'PROCESSED', provider_id: 'internal' });
    await assertLedgerMatchesBalance(container.orm, wallet.id);
  });
});
