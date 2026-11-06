import { InboxMessage } from '../../domain/messaging/inbox-message';
import { OutboxMessage } from '../../domain/messaging/outbox-message';
import { Money } from '../../domain/shared/money';
import type { FailureCode } from '../../domain/wagering/failure-code';
import { WagerTransaction } from '../../domain/wagering/wager-transaction';
import type { WagerTransactionKind } from '../../domain/wagering/wager-transaction-kind';
import type { WagerTransactionStatus } from '../../domain/wagering/wager-transaction-status';
import type { LedgerDirection } from '../../domain/wallet/ledger-direction';
import { Wallet } from '../../domain/wallet/wallet';
import { WalletLedgerEntry } from '../../domain/wallet/wallet-ledger-entry';
import type {
  InboxMessageRecord,
  LedgerEntryRecord,
  OutboxMessageRecord,
  WagerTransactionRecord,
  WalletRecord,
} from './records';

const money = (amount: string | number, currency: string) =>
  Money.fromSigned({ amount: normalizeDecimal(amount), currency: currency.trim() });

export function normalizeDecimal(value: string | number): string {
  const text = String(value);
  if (!/^-?\d+(\.\d+)?$/.test(text)) {
    throw new Error(`Unexpected decimal from database: ${text}`);
  }
  const [integer, fraction = ''] = text.split('.');
  const trimmed = fraction.replace(/0+$/, '');
  if (trimmed.length > 2) {
    throw new Error(`Unexpected decimal scale from database: ${text}`);
  }
  return trimmed ? `${integer}.${trimmed}` : integer!;
}

const toDate = (value: Date | string): Date => (value instanceof Date ? value : new Date(value));
const optionalDate = (value: Date | string | null | undefined): Date | undefined =>
  value === null || value === undefined ? undefined : toDate(value);

export const WalletMapper = {
  toDomain(record: WalletRecord): Wallet {
    return Wallet.rehydrate({
      id: record.id,
      playerId: record.playerId,
      currency: record.currency.trim(),
      balance: money(record.balance, record.currency),
      version: record.version,
      createdAt: toDate(record.createdAt),
      updatedAt: toDate(record.updatedAt),
    });
  },

  toRecord(wallet: Wallet): WalletRecord {
    return {
      id: wallet.id,
      playerId: wallet.playerId,
      currency: wallet.currency,
      balance: wallet.balance.amount,
      version: wallet.version,
      createdAt: wallet.createdAt,
      updatedAt: wallet.updatedAt,
    };
  },
};

export const WagerTransactionMapper = {
  toDomain(record: WagerTransactionRecord): WagerTransaction {
    const currency = record.currency.trim();
    return WagerTransaction.rehydrate({
      id: record.id,
      providerId: record.providerId,
      externalTransactionId: record.externalTransactionId,
      idempotencyKey: record.idempotencyKey,
      payloadHash: record.payloadHash.trim(),
      walletId: record.walletId,
      playerId: record.playerId,
      roundId: record.roundId,
      gameId: record.gameId,
      kind: record.kind as WagerTransactionKind,
      money: money(record.amount, currency),
      referenceExternalTransactionId: record.referenceExternalTransactionId ?? undefined,
      createdAt: toDate(record.createdAt),
      updatedAt: toDate(record.updatedAt),
      status: record.status as WagerTransactionStatus,
      referenceTransactionId: record.referenceTransactionId ?? undefined,
      failureCode: (record.failureCode as FailureCode | null) ?? undefined,
      processedAt: optionalDate(record.processedAt),
      resultBalance:
        record.resultBalance === null || record.resultBalance === undefined
          ? undefined
          : money(record.resultBalance, currency),
      referenceAttempts: record.referenceAttempts,
      nextReferenceAttemptAt: optionalDate(record.nextReferenceAttemptAt),
    });
  },

  toRecord(transaction: WagerTransaction): WagerTransactionRecord {
    return {
      id: transaction.id,
      providerId: transaction.providerId,
      externalTransactionId: transaction.externalTransactionId,
      idempotencyKey: transaction.idempotencyKey,
      payloadHash: transaction.payloadHash,
      walletId: transaction.walletId,
      playerId: transaction.playerId,
      roundId: transaction.roundId,
      gameId: transaction.gameId,
      kind: transaction.kind,
      amount: transaction.money.amount,
      currency: transaction.money.currency,
      referenceExternalTransactionId: transaction.referenceExternalTransactionId ?? null,
      referenceTransactionId: transaction.referenceTransactionId ?? null,
      status: transaction.status,
      failureCode: transaction.failureCode ?? null,
      resultBalance: transaction.resultBalance?.amount ?? null,
      referenceAttempts: transaction.referenceAttempts,
      nextReferenceAttemptAt: transaction.nextReferenceAttemptAt ?? null,
      processedAt: transaction.processedAt ?? null,
      createdAt: transaction.createdAt,
      updatedAt: transaction.updatedAt,
    };
  },
};

export const LedgerEntryMapper = {
  toDomain(record: LedgerEntryRecord): WalletLedgerEntry {
    const currency = record.currency.trim();
    return WalletLedgerEntry.rehydrate({
      id: record.id,
      walletId: record.walletId,
      transactionId: record.transactionId,
      direction: record.direction as LedgerDirection,
      money: money(record.amount, currency),
      balanceBefore: money(record.balanceBefore, currency),
      balanceAfter: money(record.balanceAfter, currency),
      walletVersion: record.walletVersion,
      createdAt: toDate(record.createdAt),
    });
  },

  toRecord(entry: WalletLedgerEntry): LedgerEntryRecord {
    return {
      id: entry.id,
      walletId: entry.walletId,
      transactionId: entry.transactionId,
      direction: entry.direction,
      amount: entry.money.amount,
      currency: entry.money.currency,
      balanceBefore: entry.balanceBefore.amount,
      balanceAfter: entry.balanceAfter.amount,
      walletVersion: entry.walletVersion,
      createdAt: entry.createdAt,
    };
  },
};

export const InboxMessageMapper = {
  toDomain(record: InboxMessageRecord): InboxMessage {
    return InboxMessage.rehydrate({
      messageId: record.messageId,
      consumerName: record.consumerName,
      payloadHash: record.payloadHash.trim(),
      receivedAt: toDate(record.receivedAt),
      processedAt: optionalDate(record.processedAt),
    });
  },
};

export const OutboxMessageMapper = {
  toDomain(record: OutboxMessageRecord): OutboxMessage {
    return OutboxMessage.rehydrate({
      id: record.id,
      aggregateId: record.aggregateId,
      eventType: record.eventType,
      payload: record.payload,
      occurredAt: toDate(record.occurredAt),
      attempts: record.attempts,
      nextAttemptAt: optionalDate(record.nextAttemptAt),
      publishedAt: optionalDate(record.publishedAt),
    });
  },

  toRecord(message: OutboxMessage): OutboxMessageRecord {
    return {
      id: message.id,
      aggregateId: message.aggregateId,
      eventType: message.eventType,
      payload: { ...message.payload },
      occurredAt: message.occurredAt,
      attempts: message.attempts,
      nextAttemptAt: message.nextAttemptAt ?? message.occurredAt,
      publishedAt: message.publishedAt ?? null,
      lastError: null,
    };
  },
};
