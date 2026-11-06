import { IsolationLevel } from '@mikro-orm/core';
import type { EntityManager, MikroORM } from '@mikro-orm/postgresql';
import type { TransactionScope, UnitOfWork } from '../../application/ports';
import { translateDatabaseError } from './db-errors';
import {
  MikroOrmInboxRepository,
  MikroOrmLedgerRepository,
  MikroOrmOutboxRepository,
  MikroOrmWagerTransactionRepository,
  MikroOrmWalletRepository,
} from './repositories';

export interface UnitOfWorkOptions {
  lockTimeoutMs: number;
  statementTimeoutMs: number;
}

function scopeFor(em: EntityManager): TransactionScope {
  return {
    wallets: new MikroOrmWalletRepository(em),
    transactions: new MikroOrmWagerTransactionRepository(em),
    ledger: new MikroOrmLedgerRepository(em),
    inbox: new MikroOrmInboxRepository(em),
    outbox: new MikroOrmOutboxRepository(em),
  };
}

export class MikroOrmUnitOfWork implements UnitOfWork {
  constructor(
    private readonly orm: MikroORM,
    private readonly options: UnitOfWorkOptions = { lockTimeoutMs: 5_000, statementTimeoutMs: 15_000 },
  ) {}

  async run<T>(work: (scope: TransactionScope) => Promise<T>): Promise<T> {
    try {
      return await this.orm.em.fork().transactional(
        async (em) => {
          await em.execute(
            `SELECT set_config('lock_timeout', ?, true), set_config('statement_timeout', ?, true)`,
            [`${this.options.lockTimeoutMs}ms`, `${this.options.statementTimeoutMs}ms`],
          );
          return work(scopeFor(em));
        },
        { isolationLevel: IsolationLevel.READ_COMMITTED },
      );
    } catch (error) {
      throw translateDatabaseError(error);
    }
  }

  async read<T>(work: (scope: TransactionScope) => Promise<T>): Promise<T> {
    try {
      return await work(scopeFor(this.orm.em.fork()));
    } catch (error) {
      throw translateDatabaseError(error);
    }
  }

  async ping(): Promise<void> {
    try {
      await this.orm.em.fork().execute('SELECT 1');
    } catch (error) {
      throw translateDatabaseError(error);
    }
  }
}
