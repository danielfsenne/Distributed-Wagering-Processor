import type { InboxMessage } from '../domain/messaging/inbox-message';
import type { OutboxMessage } from '../domain/messaging/outbox-message';
import type { Money } from '../domain/shared/money';
import type { WagerTransaction } from '../domain/wagering/wager-transaction';
import type { WagerTransactionStatus } from '../domain/wagering/wager-transaction-status';
import type { Wallet } from '../domain/wallet/wallet';
import type { WalletLedgerEntry } from '../domain/wallet/wallet-ledger-entry';

export const UNIT_OF_WORK = Symbol('UNIT_OF_WORK');
export const CLOCK = Symbol('CLOCK');
export const METRICS = Symbol('METRICS');
export const LOGGER = Symbol('LOGGER');
export const EVENT_PUBLISHER = Symbol('EVENT_PUBLISHER');

export interface Clock {
  now(): Date;
}

export interface WalletRepository {
  findById(id: string): Promise<Wallet | undefined>;
  lockById(id: string): Promise<Wallet | undefined>;
  lockForShareById(id: string): Promise<Wallet | undefined>;
  insert(wallet: Wallet): Promise<void>;
  saveBalance(wallet: Wallet, expectedVersion: number): Promise<void>;
}

export interface WagerTransactionRepository {
  findById(id: string): Promise<WagerTransaction | undefined>;
  findByIdempotencyKey(idempotencyKey: string): Promise<WagerTransaction | undefined>;
  findByProviderExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction | undefined>;
  hasProcessedReversal(referenceTransactionId: string): Promise<boolean>;
  insert(transaction: WagerTransaction): Promise<void>;
  update(
    transaction: WagerTransaction,
    expected: { status: WagerTransactionStatus; referenceAttempts: number },
  ): Promise<void>;
  claimDuePendingReferences(now: Date, limit: number, leaseMs: number): Promise<string[]>;
  wakePendingDependents(providerId: string, externalTransactionId: string, now: Date): Promise<number>;
}

export interface LedgerPage {
  entries: WalletLedgerEntry[];
  nextCursor: string | undefined;
}

export interface LedgerSummary {
  calculatedBalance: Money;
  entryCount: number;
}

export interface LedgerRepository {
  append(entry: WalletLedgerEntry): Promise<void>;
  page(walletId: string, after: bigint | undefined, limit: number): Promise<LedgerPage>;
  summarize(walletId: string, currency: string): Promise<LedgerSummary>;
}

export interface InboxRepository {
  tryReceive(message: InboxMessage): Promise<boolean>;
  markProcessed(message: InboxMessage, transactionId: string): Promise<void>;
}

export interface ClaimedOutboxMessage {
  message: OutboxMessage;
  sequence: bigint;
}

export interface OutboxRepository {
  enqueue(messages: OutboxMessage[]): Promise<void>;
  claimDue(now: Date, limit: number): Promise<ClaimedOutboxMessage[]>;
  markPublished(message: OutboxMessage): Promise<void>;
  scheduleRetry(message: OutboxMessage, error: string): Promise<void>;
  stats(now: Date): Promise<{ pending: number; oldestPendingAgeSeconds: number }>;
}

export interface TransactionScope {
  wallets: WalletRepository;
  transactions: WagerTransactionRepository;
  ledger: LedgerRepository;
  inbox: InboxRepository;
  outbox: OutboxRepository;
}

export interface UnitOfWork {
  run<T>(work: (scope: TransactionScope) => Promise<T>): Promise<T>;
  read<T>(work: (scope: TransactionScope) => Promise<T>): Promise<T>;
  ping(): Promise<void>;
}

export interface PublishableEvent {
  id: string;
  aggregateId: string;
  eventType: string;
  payload: Readonly<Record<string, unknown>>;
}

export interface EventPublisher {
  publish(event: PublishableEvent): Promise<void>;
}

export type TransactionSource = 'http' | 'sqs' | 'reference-worker';

export interface Metrics {
  transactionSettled(status: string, kind: string, source: TransactionSource): void;
  duplicateDetected(source: TransactionSource | 'inbox'): void;
  retry(component: string, reason: string): void;
  lockConflict(reason: string): void;
  deadLettered(reason: string): void;
  processingDuration(source: TransactionSource, seconds: number): void;
  outboxPublished(count: number): void;
  outboxPublishFailed(): void;
  outboxState(pending: number, oldestPendingAgeSeconds: number): void;
  reconciliationDivergence(): void;
}

export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
}
