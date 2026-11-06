import { MikroORM } from '@mikro-orm/postgresql';
import { createOrmConfig } from './mikro-orm.config';

export async function runMigrations(databaseUrl: string, direction: 'up' | 'down'): Promise<string[]> {
  const orm = await MikroORM.init(createOrmConfig({ databaseUrl, poolMax: 1 }));
  try {
    const migrator = orm.migrator;
    const executed = direction === 'up' ? await migrator.up() : await migrator.down();
    return executed.map((migration) => migration.name);
  } finally {
    await orm.close(true);
  }
}

if (import.meta.main) {
  const direction = process.argv[2] === 'down' ? 'down' : 'up';
  const databaseUrl = process.env.DATABASE_URL ?? 'postgres://wagering:wagering@localhost:55432/wagering';
  const executed = await runMigrations(databaseUrl, direction);
  console.log(JSON.stringify({ msg: 'migrations executed', direction, executed }));
}
