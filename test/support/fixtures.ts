import { expect } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { newId } from '../../src/domain/shared/id';

export interface WagerBody {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: { amount: string; currency: string };
  referenceExternalTransactionId?: string;
}

export function wagerBody(
  wallet: { id: string; playerId: string },
  kind: string,
  amount: string,
  overrides: Partial<WagerBody> = {},
): WagerBody {
  return {
    providerId: 'provider-a',
    externalTransactionId: `tx-${newId()}`,
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: 'round-987',
    gameId: 'fortune-chimp',
    kind,
    money: { amount, currency: 'BRL' },
    ...overrides,
  };
}

export const keyFor = (body: WagerBody) => `${body.providerId}:${body.externalTransactionId}`;

export async function assertLedgerMatchesBalance(orm: MikroORM, walletId: string): Promise<void> {
  const [row] = await orm.em.fork().execute<
    Array<{ balance: string; ledger: string; version: number; max_version: number | null; entries: string }>
  >(
    `SELECT w.balance::text AS balance,
            COALESCE(SUM(CASE e.direction WHEN 'CREDIT' THEN e.amount ELSE -e.amount END), 0)::numeric(20,2)::text AS ledger,
            w.version,
            MAX(e.wallet_version) AS max_version,
            COUNT(e.id)::text AS entries
       FROM wallets w
       LEFT JOIN wallet_ledger_entries e ON e.wallet_id = w.id
      WHERE w.id = ?
      GROUP BY w.id`,
    [walletId],
  );
  expect(row).toBeDefined();
  expect(row!.ledger).toBe(row!.balance);
  if (row!.max_version !== null) {
    expect(row!.max_version).toBe(row!.version);
  }
}

export async function countRows(orm: MikroORM, query: string, params: unknown[]): Promise<number> {
  const [row] = await orm.em.fork().execute<Array<{ count: string }>>(query, params);
  return Number(row?.count ?? 0);
}
