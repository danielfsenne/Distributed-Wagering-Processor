import type { MoneyProps } from '../../domain/shared/money';
import type { WagerTransaction } from '../../domain/wagering/wager-transaction';
import type { WalletLedgerEntry } from '../../domain/wallet/wallet-ledger-entry';
import { NotFoundError, ValidationError } from '../errors';
import type { UnitOfWork } from '../ports';
import { type WalletView, toWalletView } from './open-wallet';

export const MAX_LEDGER_PAGE_SIZE = 200;
const DEFAULT_LEDGER_PAGE_SIZE = 50;

export interface LedgerEntryView {
  id: string;
  transactionId: string;
  direction: string;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  walletVersion: number;
  createdAt: string;
}

export interface LedgerPageView {
  walletId: string;
  entries: LedgerEntryView[];
  nextCursor: string | null;
}

export interface TransactionView {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: MoneyProps;
  status: string;
  failureCode: string | null;
  referenceExternalTransactionId: string | null;
  referenceTransactionId: string | null;
  resultBalance: MoneyProps | null;
  referenceAttempts: number;
  createdAt: string;
  processedAt: string | null;
}

export function encodeCursor(sequence: bigint): string {
  return Buffer.from(JSON.stringify({ s: sequence.toString() })).toString('base64url');
}

export function decodeCursor(cursor: string | undefined): bigint | undefined {
  if (!cursor) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { s?: unknown };
    if (typeof parsed.s === 'string' && /^\d+$/.test(parsed.s)) {
      return BigInt(parsed.s);
    }
  } catch {}
  throw new ValidationError('INVALID_CURSOR', 'cursor is invalid');
}

export function parseLimit(raw: unknown): number {
  if (raw === undefined || raw === '') return DEFAULT_LEDGER_PAGE_SIZE;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > MAX_LEDGER_PAGE_SIZE) {
    throw new ValidationError('INVALID_LIMIT', `limit must be an integer between 1 and ${MAX_LEDGER_PAGE_SIZE}`);
  }
  return value;
}

function toLedgerEntryView(entry: WalletLedgerEntry): LedgerEntryView {
  return {
    id: entry.id,
    transactionId: entry.transactionId,
    direction: entry.direction,
    money: entry.money.toJSON(),
    balanceBefore: entry.balanceBefore.toJSON(),
    balanceAfter: entry.balanceAfter.toJSON(),
    walletVersion: entry.walletVersion,
    createdAt: entry.createdAt.toISOString(),
  };
}

export function toTransactionView(transaction: WagerTransaction): TransactionView {
  return {
    id: transaction.id,
    providerId: transaction.providerId,
    externalTransactionId: transaction.externalTransactionId,
    idempotencyKey: transaction.idempotencyKey,
    walletId: transaction.walletId,
    playerId: transaction.playerId,
    roundId: transaction.roundId,
    gameId: transaction.gameId,
    kind: transaction.kind,
    money: transaction.money.toJSON(),
    status: transaction.status,
    failureCode: transaction.failureCode ?? null,
    referenceExternalTransactionId: transaction.referenceExternalTransactionId ?? null,
    referenceTransactionId: transaction.referenceTransactionId ?? null,
    resultBalance: transaction.resultBalance?.toJSON() ?? null,
    referenceAttempts: transaction.referenceAttempts,
    createdAt: transaction.createdAt.toISOString(),
    processedAt: transaction.processedAt?.toISOString() ?? null,
  };
}

export class WalletQueries {
  constructor(private readonly unitOfWork: UnitOfWork) {}

  getWallet(walletId: string): Promise<WalletView> {
    return this.unitOfWork.read(async (scope) => {
      const wallet = await scope.wallets.findById(walletId);
      if (!wallet) throw NotFoundError.wallet(walletId);
      return toWalletView(wallet);
    });
  }

  getLedger(walletId: string, cursor: string | undefined, limit: number): Promise<LedgerPageView> {
    const after = decodeCursor(cursor);
    return this.unitOfWork.read(async (scope) => {
      const wallet = await scope.wallets.findById(walletId);
      if (!wallet) throw NotFoundError.wallet(walletId);
      const page = await scope.ledger.page(walletId, after, limit);
      return {
        walletId,
        entries: page.entries.map(toLedgerEntryView),
        nextCursor: page.nextCursor ?? null,
      };
    });
  }

  getTransaction(transactionId: string): Promise<TransactionView> {
    return this.unitOfWork.read(async (scope) => {
      const transaction = await scope.transactions.findById(transactionId);
      if (!transaction) throw NotFoundError.transaction(transactionId);
      return toTransactionView(transaction);
    });
  }

  getTransactionByExternalId(providerId: string, externalTransactionId: string): Promise<TransactionView> {
    return this.unitOfWork.read(async (scope) => {
      const transaction = await scope.transactions.findByProviderExternalId(providerId, externalTransactionId);
      if (!transaction) throw NotFoundError.transaction(`${providerId}/${externalTransactionId}`);
      return toTransactionView(transaction);
    });
  }
}
