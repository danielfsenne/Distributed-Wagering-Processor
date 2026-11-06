import { afterAll } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import { createOrmConfig } from '../../src/infrastructure/persistence/mikro-orm.config';
import { TEST_DATABASE_URL } from './database';
import { intentionallyCorruptedWallets } from './invariants';

const runStartedAt = new Date(Date.now() - 1_000);

interface Violation {
  wallet_id: string;
  balance: string;
  ledger: string;
  version: number;
  ledger_version: number;
}

afterAll(async () => {
  const orm = await MikroORM.init(createOrmConfig({ databaseUrl: TEST_DATABASE_URL, poolMax: 1 }));
  try {
    const excluded = intentionallyCorruptedWallets();
    const [summary] = await orm.em.fork().execute<Array<{ checked: string }>>(
      `SELECT COUNT(*)::text AS checked FROM wallets WHERE created_at >= ?`,
      [runStartedAt],
    );
    const violations = await orm.em.fork().execute<Violation[]>(
      `SELECT w.id AS wallet_id,
              w.balance::text AS balance,
              COALESCE(SUM(CASE e.direction WHEN 'CREDIT' THEN e.amount ELSE -e.amount END), 0)::numeric(20,2)::text AS ledger,
              w.version,
              COALESCE(MAX(e.wallet_version), 1) AS ledger_version
         FROM wallets w
         LEFT JOIN wallet_ledger_entries e ON e.wallet_id = w.id
        WHERE w.created_at >= ?
          AND NOT (w.id = ANY(?::uuid[]))
        GROUP BY w.id
       HAVING w.balance <> COALESCE(SUM(CASE e.direction WHEN 'CREDIT' THEN e.amount ELSE -e.amount END), 0)
           OR w.version <> COALESCE(MAX(e.wallet_version), 1)`,
      [runStartedAt, `{${excluded.join(',')}}`],
    );
    if (violations.length > 0) {
      throw new Error(
        `Global invariant violated (wallet.balance == ledger, wallet.version == last ledger version):\n${JSON.stringify(violations, null, 2)}`,
      );
    }
    console.log(
      `global invariant ok: ${Number(summary?.checked ?? 0) - excluded.length} wallets created in this run have balance == ledger (${excluded.length} intentionally corrupted excluded)`,
    );
  } finally {
    await orm.close(true);
  }
});
