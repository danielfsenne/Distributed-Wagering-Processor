import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import { runMigrations } from '../../src/infrastructure/persistence/migrate';
import { createOrmConfig } from '../../src/infrastructure/persistence/mikro-orm.config';
import { TEST_DATABASE_URL } from '../support/database';

const SCRATCH_DB = `wagering_migrations_${process.pid}`;
const scratchUrl = TEST_DATABASE_URL.replace(/\/[^/]+$/, `/${SCRATCH_DB}`);

let admin: MikroORM;

async function tables(): Promise<string[]> {
  const orm = await MikroORM.init(createOrmConfig({ databaseUrl: scratchUrl, poolMax: 1 }));
  try {
    const rows = await orm.em.fork().execute<Array<{ table_name: string }>>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name <> 'schema_migrations' ORDER BY table_name`,
    );
    return rows.map((row) => row.table_name);
  } finally {
    await orm.close(true);
  }
}

beforeAll(async () => {
  admin = await MikroORM.init(createOrmConfig({ databaseUrl: TEST_DATABASE_URL, poolMax: 1 }));
  await admin.em.fork().execute(`DROP DATABASE IF EXISTS ${SCRATCH_DB}`);
  await admin.em.fork().execute(`CREATE DATABASE ${SCRATCH_DB}`);
});

afterAll(async () => {
  await admin.em.fork().execute(`DROP DATABASE IF EXISTS ${SCRATCH_DB} WITH (FORCE)`);
  await admin.close(true);
});

describe('migrations', () => {
  it('are reversible: up, down and up again', async () => {
    expect(await runMigrations(scratchUrl, 'up')).toEqual(['Migration20261106000001InitialSchema']);
    expect(await tables()).toEqual([
      'inbox_messages',
      'outbox_messages',
      'wager_transactions',
      'wallet_ledger_entries',
      'wallets',
    ]);

    expect(await runMigrations(scratchUrl, 'down')).toEqual(['Migration20261106000001InitialSchema']);
    expect(await tables()).toEqual([]);

    expect(await runMigrations(scratchUrl, 'up')).toEqual(['Migration20261106000001InitialSchema']);
    expect(await runMigrations(scratchUrl, 'up')).toEqual([]);
  });
});
