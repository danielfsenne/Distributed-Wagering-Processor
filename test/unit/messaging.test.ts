import { describe, expect, it } from 'bun:test';
import {
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
} from '../../src/domain/messaging/events';
import { InboxMessage } from '../../src/domain/messaging/inbox-message';
import { OutboxMessage } from '../../src/domain/messaging/outbox-message';
import { FailureCode } from '../../src/domain/wagering/failure-code';
import { WagerTransactionKind } from '../../src/domain/wagering/wager-transaction-kind';
import { LedgerDirection } from '../../src/domain/wallet/ledger-direction';
import { NOW, brl, openWallet, tx } from './fixtures';

const context = { correlationId: 'corr-1', causationId: 'msg-1', occurredAt: NOW };

describe('InboxMessage', () => {
  it('is received unprocessed and can be marked processed once', () => {
    const message = InboxMessage.receive({
      messageId: 'msg-1',
      consumerName: 'wager-consumer',
      payloadHash: 'h',
      at: NOW,
    });
    expect(message.isProcessed()).toBe(false);
    message.markProcessed(NOW);
    expect(message.isProcessed()).toBe(true);
    expect(() => message.markProcessed(NOW)).toThrow();
  });
});

describe('Integration events', () => {
  it('serializes WalletBalanceChanged with MoneyProps and a stable envelope', () => {
    const wallet = openWallet('100.00');
    const entry = wallet.debit(brl('25.00'), { transactionId: 'tx-1', at: NOW });
    const event = WalletBalanceChanged.from(wallet, entry, context);
    const json = event.toJSON();

    expect(json).toEqual({
      eventId: event.eventId,
      eventType: 'WalletBalanceChanged',
      aggregateId: wallet.id,
      correlationId: 'corr-1',
      causationId: 'msg-1',
      occurredAt: '2026-07-29T15:00:00.000Z',
      version: 1,
      data: {
        walletId: wallet.id,
        transactionId: 'tx-1',
        direction: LedgerDirection.Debit,
        money: { amount: '25.00', currency: 'BRL' },
        balanceBefore: { amount: '100.00', currency: 'BRL' },
        balanceAfter: { amount: '75.00', currency: 'BRL' },
        walletVersion: 2,
      },
    });
    expect(JSON.parse(JSON.stringify(event))).toEqual(json);
  });

  it('carries event type and version on the class', () => {
    const wallet = openWallet('100.00');
    const bet = tx(wallet, WagerTransactionKind.Bet, '10.00');
    bet.markProcessed(undefined, NOW, brl('90.00'));
    const processed = WagerTransactionProcessed.from(bet, context);
    expect(processed.eventType).toBe('WagerTransactionProcessed');
    expect(processed.version).toBe(1);
    expect(processed.aggregateId).toBe(bet.id);
    expect(processed.toJSON().data.balance).toEqual({ amount: '90.00', currency: 'BRL' });
  });

  it('includes the failure code on rejections', () => {
    const wallet = openWallet('1.00');
    const bet = tx(wallet, WagerTransactionKind.Bet, '10.00');
    bet.reject(FailureCode.InsufficientFunds, NOW, brl('1.00'));
    expect(WagerTransactionRejected.from(bet, context).toJSON().data.failureCode).toBe(
      FailureCode.InsufficientFunds,
    );
  });

  it('generates unique event ids', () => {
    const wallet = openWallet('100.00');
    const entry = wallet.credit(brl('1.00'), { transactionId: 'tx', at: NOW });
    const ids = new Set(
      Array.from({ length: 100 }, () => WalletBalanceChanged.from(wallet, entry, context).eventId),
    );
    expect(ids.size).toBe(100);
  });
});

describe('OutboxMessage', () => {
  const event = () => {
    const wallet = openWallet('100.00');
    const entry = wallet.credit(brl('1.00'), { transactionId: 'tx', at: NOW });
    return WalletBalanceChanged.from(wallet, entry, context);
  };

  it('enqueues the serialized envelope, due immediately', () => {
    const source = event();
    const message = OutboxMessage.enqueue(source);
    expect(message.id).toBe(source.eventId);
    expect(message.eventType).toBe('WalletBalanceChanged');
    expect(message.payload).toEqual(source.toJSON() as unknown as Record<string, unknown>);
    expect(message.isPending()).toBe(true);
    expect(message.isDue(NOW)).toBe(true);
  });

  it('backs off exponentially up to a cap', () => {
    const message = OutboxMessage.enqueue(event());
    const policy = { baseDelayMs: 1_000, maxDelayMs: 5_000 };
    const delays = [1, 2, 3, 4, 5].map(() => {
      message.scheduleRetry(NOW, policy);
      return message.nextAttemptAt!.getTime() - NOW.getTime();
    });
    expect(delays).toEqual([1_000, 2_000, 4_000, 5_000, 5_000]);
    expect(message.attempts).toBe(5);
    expect(message.isDue(NOW)).toBe(false);
    expect(message.isDue(new Date(NOW.getTime() + 5_000))).toBe(true);
  });

  it('is no longer pending once published', () => {
    const message = OutboxMessage.enqueue(event());
    message.markPublished(NOW);
    expect(message.isPending()).toBe(false);
    expect(message.isDue(NOW)).toBe(false);
    expect(message.publishedAt).toEqual(NOW);
  });
});
