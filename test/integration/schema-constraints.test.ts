import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { newId } from '../../src/domain/shared/id';
import { createTestOrm } from '../support/database';

let orm: MikroORM;

beforeAll(async () => {
  orm = await createTestOrm(5);
});

afterAll(async () => {
  await orm.close(true);
});

const NOW = '2026-07-29T15:00:00Z';

async function sql(query: string, params: unknown[] = []) {
  return orm.em.fork().execute(query, params);
}

async function inTransaction(statements: Array<[string, unknown[]]>) {
  await orm.em.fork().transactional(async (em) => {
    for (const [query, params] of statements) {
      await em.execute(query, params);
    }
  });
}

function insertWallet(id: string, balance = '0.00', version = 1, playerId = newId()): [string, unknown[]] {
  return [
    `INSERT INTO wallets (id, player_id, currency, balance, version, created_at, updated_at)
     VALUES (?, ?, 'BRL', ?, ?, ?, ?)`,
    [id, playerId, balance, version, NOW, NOW],
  ];
}

function insertTransaction(
  id: string,
  walletId: string,
  overrides: Partial<{
    kind: string;
    amount: string;
    status: string;
    failureCode: string | null;
    providerId: string;
    externalId: string;
    key: string;
    reference: string | null;
    referenceTransactionId: string | null;
    resultBalance: string | null;
    processedAt: string | null;
    currency: string;
  }> = {},
): [string, unknown[]] {
  const providerId = overrides.providerId ?? 'provider-a';
  const externalId = overrides.externalId ?? newId();
  const status = overrides.status ?? 'PROCESSED';
  const terminal = ['PROCESSED', 'REJECTED', 'FAILED'].includes(status);
  return [
    `INSERT INTO wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash,
       wallet_id, player_id, round_id, game_id, kind, amount, currency, reference_external_transaction_id,
       reference_transaction_id, status, failure_code, result_balance, reference_attempts,
       next_reference_attempt_at, processed_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'round', 'game', ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`,
    [
      id,
      providerId,
      externalId,
      overrides.key ?? `${providerId}:${externalId}`,
      'a'.repeat(64),
      walletId,
      newId(),
      overrides.kind ?? 'BET',
      overrides.amount ?? '10.00',
      overrides.currency ?? 'BRL',
      overrides.reference ?? null,
      overrides.referenceTransactionId ?? null,
      status,
      overrides.failureCode ?? null,
      overrides.resultBalance !== undefined ? overrides.resultBalance : terminal && status !== 'FAILED' ? '0.00' : null,
      status === 'PENDING_REFERENCE' ? NOW : null,
      overrides.processedAt !== undefined ? overrides.processedAt : terminal ? NOW : null,
      NOW,
      NOW,
    ],
  ];
}

function insertEntry(
  walletId: string,
  transactionId: string,
  direction: 'DEBIT' | 'CREDIT',
  amount: string,
  before: string,
  after: string,
  version: number,
  id = newId(),
): [string, unknown[]] {
  return [
    `INSERT INTO wallet_ledger_entries (id, wallet_id, transaction_id, direction, amount, currency,
       balance_before, balance_after, wallet_version, created_at)
     VALUES (?, ?, ?, ?, ?, 'BRL', ?, ?, ?, ?)`,
    [id, walletId, transactionId, direction, amount, before, after, version, NOW],
  ];
}

function updateWallet(walletId: string, balance: string, version: number): [string, unknown[]] {
  return [`UPDATE wallets SET balance = ?, version = ?, updated_at = ? WHERE id = ?`, [balance, version, NOW, walletId]];
}

async function walletWithOpening(balance = '100.00') {
  const walletId = newId();
  const openingId = newId();
  await inTransaction([
    insertWallet(walletId, balance),
    insertTransaction(openingId, walletId, {
      kind: 'OPENING',
      providerId: 'internal',
      amount: balance,
      resultBalance: balance,
    }),
    insertEntry(walletId, openingId, 'CREDIT', balance, '0.00', balance, 1),
  ]);
  return { walletId, openingId };
}

async function debit(walletId: string, amount: string, before: string, after: string, version: number) {
  const transactionId = newId();
  await inTransaction([
    insertTransaction(transactionId, walletId, { amount, resultBalance: after }),
    insertEntry(walletId, transactionId, 'DEBIT', amount, before, after, version),
    updateWallet(walletId, after, version),
  ]);
  return transactionId;
}

async function expectViolation(promise: Promise<unknown>, pattern: RegExp) {
  let error: unknown;
  try {
    await promise;
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeDefined();
  expect(String((error as Error).message)).toMatch(pattern);
}

describe('schema constraints', () => {
  it('accepts a consistent wallet, transaction, ledger and balance update', async () => {
    const { walletId } = await walletWithOpening('100.00');
    await debit(walletId, '80.00', '100.00', '20.00', 2);
    const [wallet] = await sql('SELECT balance, version FROM wallets WHERE id = ?', [walletId]);
    expect(wallet).toEqual({ balance: '20.00', version: 2 });
  });

  describe('wallets', () => {
    it('allows only one wallet per player and currency', async () => {
      const playerId = newId();
      await inTransaction([insertWallet(newId(), '0.00', 1, playerId)]);
      await expectViolation(
        inTransaction([insertWallet(newId(), '0.00', 1, playerId)]),
        /wallets_player_currency_key/,
      );
    });

    it('never stores a negative balance', async () => {
      await expectViolation(
        inTransaction([insertWallet(newId(), '-1.00')]),
        /wallets_balance_non_negative/,
      );
    });

    it('requires a ledger entry for every balance change', async () => {
      const { walletId } = await walletWithOpening('100.00');
      await expectViolation(
        inTransaction([updateWallet(walletId, '150.00', 2)]),
        /has no matching ledger entry/,
      );
    });

    it('requires an opening entry for a positive initial balance', async () => {
      await expectViolation(inTransaction([insertWallet(newId(), '10.00')]), /has no matching ledger entry/);
    });

    it('increments version exactly once per balance change', async () => {
      const { walletId } = await walletWithOpening('100.00');
      await expectViolation(
        inTransaction([updateWallet(walletId, '90.00', 5)]),
        /increment version by exactly 1/,
      );
      await expectViolation(inTransaction([updateWallet(walletId, '100.00', 2)]), /only change with its balance/);
    });

    it('cannot be deleted or truncated', async () => {
      const { walletId } = await walletWithOpening('1.00');
      await expectViolation(sql('DELETE FROM wallets WHERE id = ?', [walletId]), /not allowed/);
      await expectViolation(sql('TRUNCATE wallets CASCADE'), /not allowed/);
    });
  });

  describe('ledger', () => {
    it('is append-only', async () => {
      const { walletId } = await walletWithOpening('100.00');
      await expectViolation(
        sql(`UPDATE wallet_ledger_entries SET amount = 1 WHERE wallet_id = ?`, [walletId]),
        /not allowed/,
      );
      await expectViolation(sql(`DELETE FROM wallet_ledger_entries WHERE wallet_id = ?`, [walletId]), /not allowed/);
      await expectViolation(sql('TRUNCATE wallet_ledger_entries'), /not allowed/);
    });

    it('rejects entries whose arithmetic does not balance', async () => {
      const { walletId } = await walletWithOpening('100.00');
      const transactionId = newId();
      await expectViolation(
        inTransaction([
          insertTransaction(transactionId, walletId, { amount: '10.00' }),
          insertEntry(walletId, transactionId, 'DEBIT', '10.00', '100.00', '91.00', 2),
        ]),
        /wallet_ledger_entries_balanced/,
      );
    });

    it('allows at most one entry per transaction and wallet', async () => {
      const { walletId } = await walletWithOpening('100.00');
      const transactionId = newId();
      await expectViolation(
        inTransaction([
          insertTransaction(transactionId, walletId, { amount: '10.00' }),
          insertEntry(walletId, transactionId, 'DEBIT', '10.00', '100.00', '90.00', 2),
          insertEntry(walletId, transactionId, 'DEBIT', '10.00', '90.00', '80.00', 3),
        ]),
        /wallet_ledger_entries_transaction_wallet_key/,
      );
    });

    it('rejects a broken balance chain', async () => {
      const { walletId } = await walletWithOpening('100.00');
      const transactionId = newId();
      await expectViolation(
        inTransaction([
          insertTransaction(transactionId, walletId, { amount: '10.00' }),
          insertEntry(walletId, transactionId, 'DEBIT', '10.00', '50.00', '40.00', 2),
        ]),
        /ledger chain broken/,
      );
    });

    it('rejects two entries for the same wallet version', async () => {
      const { walletId } = await walletWithOpening('100.00');
      const first = newId();
      const second = newId();
      await expectViolation(
        inTransaction([
          insertTransaction(first, walletId, { amount: '10.00' }),
          insertTransaction(second, walletId, { amount: '10.00' }),
          insertEntry(walletId, first, 'DEBIT', '10.00', '100.00', '90.00', 2),
          insertEntry(walletId, second, 'DEBIT', '10.00', '100.00', '90.00', 2),
        ]),
        /wallet_ledger_entries_wallet_version_key/,
      );
    });

    it('only records entries for processed, balance-affecting transactions', async () => {
      const { walletId } = await walletWithOpening('100.00');
      const rejected = newId();
      await expectViolation(
        inTransaction([
          insertTransaction(rejected, walletId, { status: 'REJECTED', failureCode: 'INSUFFICIENT_FUNDS' }),
          insertEntry(walletId, rejected, 'DEBIT', '10.00', '100.00', '90.00', 2),
        ]),
        /does not match a processed balance-affecting transaction/,
      );
    });
  });

  describe('wager transactions', () => {
    it('enforces idempotency key and provider external id uniqueness', async () => {
      const { walletId } = await walletWithOpening('100.00');
      await debit(walletId, '1.00', '100.00', '99.00', 2);
      const [existing] = await sql(
        `SELECT idempotency_key, external_transaction_id FROM wager_transactions
         WHERE wallet_id = ? AND kind = 'BET'`,
        [walletId],
      );
      const transaction = existing as { idempotency_key: string; external_transaction_id: string };

      await expectViolation(
        inTransaction([
          insertTransaction(newId(), walletId, {
            status: 'REJECTED',
            failureCode: 'X',
            key: transaction.idempotency_key,
          }),
        ]),
        /wager_transactions_idempotency_key_key/,
      );
      await expectViolation(
        inTransaction([
          insertTransaction(newId(), walletId, {
            status: 'REJECTED',
            failureCode: 'X',
            externalId: transaction.external_transaction_id,
            key: newId(),
          }),
        ]),
        /wager_transactions_provider_external_key/,
      );
    });

    it('requires a ledger entry for processed balance-affecting transactions', async () => {
      const { walletId } = await walletWithOpening('100.00');
      await expectViolation(
        inTransaction([insertTransaction(newId(), walletId, { kind: 'WIN' })]),
        /has no ledger entry/,
      );
    });

    it('requires a reference for REFUND and ROLLBACK', async () => {
      const { walletId } = await walletWithOpening('100.00');
      await expectViolation(
        inTransaction([
          insertTransaction(newId(), walletId, { kind: 'REFUND', status: 'REJECTED', failureCode: 'X' }),
        ]),
        /wager_transactions_reference_required/,
      );
    });

    it('reserves OPENING for the internal provider', async () => {
      const { walletId } = await walletWithOpening('100.00');
      await expectViolation(
        inTransaction([
          insertTransaction(newId(), walletId, { kind: 'OPENING', status: 'REJECTED', failureCode: 'X' }),
        ]),
        /wager_transactions_opening_is_internal/,
      );
    });

    it('requires a failure code exactly for rejected and failed transactions', async () => {
      const { walletId } = await walletWithOpening('100.00');
      await expectViolation(
        inTransaction([insertTransaction(newId(), walletId, { status: 'REJECTED' })]),
        /wager_transactions_failure_code_matches_status/,
      );
    });

    it('freezes terminal transactions', async () => {
      const { walletId, openingId } = await walletWithOpening('100.00');
      await expectViolation(
        sql(`UPDATE wager_transactions SET status = 'REJECTED', failure_code = 'X' WHERE id = ?`, [openingId]),
        /terminal status/,
      );
      await expectViolation(sql(`DELETE FROM wager_transactions WHERE wallet_id = ?`, [walletId]), /not allowed/);
    });

    it('freezes business columns of pending transactions', async () => {
      const { walletId } = await walletWithOpening('100.00');
      const pendingId = newId();
      await inTransaction([
        insertTransaction(pendingId, walletId, { kind: 'REFUND', status: 'PENDING_REFERENCE', reference: 'missing' }),
      ]);
      await expectViolation(
        sql(`UPDATE wager_transactions SET amount = 99 WHERE id = ?`, [pendingId]),
        /business columns are immutable/,
      );
      await sql(`UPDATE wager_transactions SET reference_attempts = 2 WHERE id = ?`, [pendingId]);
    });

    it('allows a reference to be reversed only once', async () => {
      const { walletId } = await walletWithOpening('100.00');
      const betId = await debit(walletId, '10.00', '100.00', '90.00', 2);
      const refundId = newId();
      await inTransaction([
        insertTransaction(refundId, walletId, {
          kind: 'REFUND',
          reference: 'bet',
          referenceTransactionId: betId,
          resultBalance: '100.00',
        }),
        insertEntry(walletId, refundId, 'CREDIT', '10.00', '90.00', '100.00', 3),
        updateWallet(walletId, '100.00', 3),
      ]);

      const rollbackId = newId();
      await expectViolation(
        inTransaction([
          insertTransaction(rollbackId, walletId, {
            kind: 'ROLLBACK',
            reference: 'bet',
            referenceTransactionId: betId,
            resultBalance: '110.00',
          }),
          insertEntry(walletId, rollbackId, 'CREDIT', '10.00', '100.00', '110.00', 4),
          updateWallet(walletId, '110.00', 4),
        ]),
        /wager_transactions_single_reversal_idx/,
      );
    });
  });
});
