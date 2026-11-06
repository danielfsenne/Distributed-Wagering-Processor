import { Migrator } from '@mikro-orm/migrations';
import { defineConfig } from '@mikro-orm/postgresql';
import { Migration20261106000001InitialSchema } from './migrations/Migration20261106000001InitialSchema';
import { ENTITY_SCHEMAS } from './records';

export interface OrmConfigOptions {
  databaseUrl: string;
  poolMax?: number;
  debug?: boolean;
}

export function createOrmConfig(options: OrmConfigOptions) {
  return defineConfig({
    clientUrl: options.databaseUrl,
    entities: ENTITY_SCHEMAS,
    extensions: [Migrator],
    allowGlobalContext: false,
    debug: options.debug ?? false,
    pool: { min: 0, max: options.poolMax ?? 10 },
    migrations: {
      tableName: 'schema_migrations',
      transactional: true,
      allOrNothing: true,
      snapshot: false,
      migrationsList: [
        {
          name: 'Migration20261106000001InitialSchema',
          class: Migration20261106000001InitialSchema,
        },
      ],
    },
  });
}
