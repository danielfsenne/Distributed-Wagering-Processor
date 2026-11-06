import { LockMode } from '@mikro-orm/core';
import type { EntityManager } from '@mikro-orm/postgresql';
import { ConcurrencyConflictError } from '../../application/errors';
import type {
  ClaimedOutboxMessage,
  InboxRepository,
  LedgerPage,
  LedgerRepository,
  LedgerSummary,
  OutboxRepository,
  WagerTransactionRepository,
  WalletRepository,
} from '../../application/ports';
import { encodeCursor } from '../../application/wallets/wallet-queries';
import type { InboxMessage } from '../../domain/messaging/inbox-message';
import type { OutboxMessage } from '../../domain/messaging/outbox-message';
import { Money } from '../../domain/shared/money';
import type { WagerTransaction } from '../../domain/wagering/wager-transaction';
import { WagerTransactionStatus } from '../../domain/wagering/wager-transaction-status';
import type { Wallet } from '../../domain/wallet/wallet';
import type { WalletLedgerEntry } from '../../domain/wallet/wallet-ledger-entry';
import {
  LedgerEntryMapper,
  OutboxMessageMapper,
  WagerTransactionMapper,
  WalletMapper,
  normalizeDecimal,
} from './mappers';
import {
  LedgerEntrySchema,
  OutboxMessageSchema,
  type OutboxMessageRecord,
  WagerTransactionSchema,
  WalletSchema,
} from './records';

const READ = { disableIdentityMap: true } as const;

export class MikroOrmWalletRepository implements WalletRepository {
  constructor(private readonly em: EntityManager) {}

  async findById(id: string): Promise<Wallet | undefined> {
    const record = await this.em.findOne(WalletSchema, { id }, READ);
    return record ? WalletMapper.toDomain(record) : undefined;
  }

  async lockById(id: string): Promise<Wallet | undefined> {
    const record = await this.em.findOne(
      WalletSchema,
      { id },
      { ...READ, lockMode: LockMode.PESSIMISTIC_WRITE },
    );
    return record ? WalletMapper.toDomain(record) : undefined;
  }

  async lockForShareById(id: string): Promise<Wallet | undefined> {
    const record = await this.em.findOne(
      WalletSchema,
      { id },
      { ...READ, lockMode: LockMode.PESSIMISTIC_READ },
    );
    return record ? WalletMapper.toDomain(record) : undefined;
  }

  async insert(wallet: Wallet): Promise<void> {
    await this.em.insert(WalletSchema, WalletMapper.toRecord(wallet));
  }

  async saveBalance(wallet: Wallet, expectedVersion: number): Promise<void> {
    const affected = await this.em.nativeUpdate(
      WalletSchema,
      { id: wallet.id, version: expectedVersion },
      { balance: wallet.balance.amount, version: wallet.version, updatedAt: wallet.updatedAt },
    );
    if (affected !== 1) {
      throw new ConcurrencyConflictError(
        'version_mismatch',
        `wallet ${wallet.id} is no longer at version ${expectedVersion}`,
      );
    }
  }
}

export class MikroOrmWagerTransactionRepository implements WagerTransactionRepository {
  constructor(private readonly em: EntityManager) {}

  async findById(id: string): Promise<WagerTransaction | undefined> {
    const record = await this.em.findOne(WagerTransactionSchema, { id }, READ);
    return record ? WagerTransactionMapper.toDomain(record) : undefined;
  }

  async findByIdempotencyKey(idempotencyKey: string): Promise<WagerTransaction | undefined> {
    const record = await this.em.findOne(WagerTransactionSchema, { idempotencyKey }, READ);
    return record ? WagerTransactionMapper.toDomain(record) : undefined;
  }

  async findByProviderExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction | undefined> {
    const record = await this.em.findOne(
      WagerTransactionSchema,
      { providerId, externalTransactionId },
      READ,
    );
    return record ? WagerTransactionMapper.toDomain(record) : undefined;
  }

  async hasProcessedReversal(referenceTransactionId: string): Promise<boolean> {
    const count = await this.em.count(WagerTransactionSchema, {
      referenceTransactionId,
      status: WagerTransactionStatus.Processed,
      kind: { $in: ['REFUND', 'ROLLBACK'] },
    });
    return count > 0;
  }

  async insert(transaction: WagerTransaction): Promise<void> {
    await this.em.insert(WagerTransactionSchema, WagerTransactionMapper.toRecord(transaction));
  }

  async update(
    transaction: WagerTransaction,
    expected: { status: WagerTransactionStatus; referenceAttempts: number },
  ): Promise<void> {
    const record = WagerTransactionMapper.toRecord(transaction);
    const affected = await this.em.nativeUpdate(
      WagerTransactionSchema,
      { id: transaction.id, status: expected.status, referenceAttempts: expected.referenceAttempts },
      {
        status: record.status,
        referenceTransactionId: record.referenceTransactionId,
        failureCode: record.failureCode,
        resultBalance: record.resultBalance,
        referenceAttempts: record.referenceAttempts,
        nextReferenceAttemptAt: record.nextReferenceAttemptAt,
        processedAt: record.processedAt,
        updatedAt: record.updatedAt,
      },
    );
    if (affected !== 1) {
      throw new ConcurrencyConflictError(
        'status_changed',
        `transaction ${transaction.id} changed concurrently`,
      );
    }
  }

  async claimDuePendingReferences(now: Date, limit: number, leaseMs: number): Promise<string[]> {
    const rows = await this.em.execute<Array<{ id: string }>>(
      `UPDATE wager_transactions
          SET next_reference_attempt_at = ?
        WHERE id IN (
          SELECT id FROM wager_transactions
           WHERE status = 'PENDING_REFERENCE' AND next_reference_attempt_at <= ?
           ORDER BY next_reference_attempt_at
           LIMIT ?
           FOR UPDATE SKIP LOCKED
        )
        RETURNING id`,
      [new Date(now.getTime() + leaseMs), now, limit],
    );
    return rows.map((row) => row.id);
  }

  async wakePendingDependents(providerId: string, externalTransactionId: string, now: Date): Promise<number> {
    return this.em.nativeUpdate(
      WagerTransactionSchema,
      {
        providerId,
        referenceExternalTransactionId: externalTransactionId,
        status: WagerTransactionStatus.PendingReference,
        nextReferenceAttemptAt: { $gt: now },
      },
      { nextReferenceAttemptAt: now },
    );
  }
}

export class MikroOrmLedgerRepository implements LedgerRepository {
  constructor(private readonly em: EntityManager) {}

  async append(entry: WalletLedgerEntry): Promise<void> {
    await this.em.insert(LedgerEntrySchema, LedgerEntryMapper.toRecord(entry));
  }

  async page(walletId: string, after: bigint | undefined, limit: number): Promise<LedgerPage> {
    const records = await this.em.find(
      LedgerEntrySchema,
      after === undefined ? { walletId } : { walletId, sequence: { $gt: after.toString() } },
      { ...READ, orderBy: { sequence: 'asc' }, limit: limit + 1 },
    );
    const hasMore = records.length > limit;
    const visible = hasMore ? records.slice(0, limit) : records;
    const last = visible.at(-1);
    return {
      entries: visible.map(LedgerEntryMapper.toDomain),
      nextCursor: hasMore && last?.sequence ? encodeCursor(BigInt(last.sequence)) : undefined,
    };
  }

  async summarize(walletId: string, currency: string): Promise<LedgerSummary> {
    const [row] = await this.em.execute<Array<{ total: string; entries: string }>>(
      `SELECT COALESCE(SUM(CASE direction WHEN 'CREDIT' THEN amount ELSE -amount END), 0)::text AS total,
              COUNT(*)::text AS entries
         FROM wallet_ledger_entries
        WHERE wallet_id = ?`,
      [walletId],
    );
    return {
      calculatedBalance: Money.fromSigned({ amount: normalizeDecimal(row?.total ?? '0'), currency }),
      entryCount: Number(row?.entries ?? 0),
    };
  }
}

export class MikroOrmInboxRepository implements InboxRepository {
  constructor(private readonly em: EntityManager) {}

  async tryReceive(message: InboxMessage): Promise<boolean> {
    const rows = await this.em.execute<Array<{ message_id: string }>>(
      `INSERT INTO inbox_messages (consumer_name, message_id, payload_hash, received_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (consumer_name, message_id) DO NOTHING
       RETURNING message_id`,
      [message.consumerName, message.messageId, message.payloadHash, message.receivedAt],
    );
    return rows.length === 1;
  }

  async markProcessed(message: InboxMessage, transactionId: string): Promise<void> {
    await this.em.execute(
      `UPDATE inbox_messages SET processed_at = ?, transaction_id = ?
        WHERE consumer_name = ? AND message_id = ?`,
      [message.processedAt ?? new Date(), transactionId, message.consumerName, message.messageId],
    );
  }
}

interface OutboxRow {
  id: string;
  sequence: string;
  aggregate_id: string;
  event_type: string;
  payload: Record<string, unknown> | string;
  occurred_at: Date;
  attempts: number;
  next_attempt_at: Date;
  published_at: Date | null;
  last_error: string | null;
}

export class MikroOrmOutboxRepository implements OutboxRepository {
  constructor(private readonly em: EntityManager) {}

  async enqueue(messages: OutboxMessage[]): Promise<void> {
    if (messages.length === 0) return;
    await this.em.insertMany(OutboxMessageSchema, messages.map(OutboxMessageMapper.toRecord));
  }

  async claimDue(now: Date, limit: number): Promise<ClaimedOutboxMessage[]> {
    const rows = await this.em.execute<OutboxRow[]>(
      `SELECT id, sequence::text AS sequence, aggregate_id, event_type, payload, occurred_at, attempts,
              next_attempt_at, published_at, last_error
         FROM outbox_messages
        WHERE published_at IS NULL AND next_attempt_at <= ?
        ORDER BY sequence
        LIMIT ?
        FOR UPDATE SKIP LOCKED`,
      [now, limit],
    );
    return rows.map((row) => {
      const record: OutboxMessageRecord = {
        id: row.id,
        aggregateId: row.aggregate_id,
        eventType: row.event_type,
        payload: typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload,
        occurredAt: row.occurred_at,
        attempts: row.attempts,
        nextAttemptAt: row.next_attempt_at,
        publishedAt: row.published_at,
        lastError: row.last_error,
      };
      return { message: OutboxMessageMapper.toDomain(record), sequence: BigInt(row.sequence) };
    });
  }

  async markPublished(message: OutboxMessage): Promise<void> {
    await this.em.nativeUpdate(
      OutboxMessageSchema,
      { id: message.id, publishedAt: null },
      { publishedAt: message.publishedAt ?? new Date(), lastError: null },
    );
  }

  async scheduleRetry(message: OutboxMessage, error: string): Promise<void> {
    await this.em.nativeUpdate(
      OutboxMessageSchema,
      { id: message.id, publishedAt: null },
      {
        attempts: message.attempts,
        nextAttemptAt: message.nextAttemptAt ?? new Date(),
        lastError: error.slice(0, 2000),
      },
    );
  }

  async stats(now: Date): Promise<{ pending: number; oldestPendingAgeSeconds: number }> {
    const [row] = await this.em.execute<Array<{ pending: string; oldest: Date | null }>>(
      `SELECT COUNT(*)::text AS pending, MIN(occurred_at) AS oldest
         FROM outbox_messages WHERE published_at IS NULL`,
    );
    const oldest = row?.oldest ? new Date(row.oldest) : undefined;
    return {
      pending: Number(row?.pending ?? 0),
      oldestPendingAgeSeconds: oldest ? Math.max(0, (now.getTime() - oldest.getTime()) / 1000) : 0,
    };
  }
}
