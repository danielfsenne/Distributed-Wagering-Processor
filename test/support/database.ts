import { MikroORM } from '@mikro-orm/postgresql';
import { runMigrations } from '../../src/infrastructure/persistence/migrate';
import { createOrmConfig } from '../../src/infrastructure/persistence/mikro-orm.config';

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://wagering:wagering@localhost:55432/wagering_test';

let migrated: Promise<unknown> | undefined;

export function ensureMigrated(): Promise<unknown> {
  migrated ??= runMigrations(TEST_DATABASE_URL, 'up');
  return migrated;
}

export async function createTestOrm(poolMax = 20): Promise<MikroORM> {
  await ensureMigrated();
  return MikroORM.init(createOrmConfig({ databaseUrl: TEST_DATABASE_URL, poolMax }));
}
