import { describe, expect, it } from 'bun:test';
import {
  InvalidAmountError,
  InvalidTransactionError,
  InvalidTransactionStateError,
} from '../../src/domain/shared/domain-error';
import { Money } from '../../src/domain/shared/money';
import { FailureCode } from '../../src/domain/wagering/failure-code';
import { WagerTransaction } from '../../src/domain/wagering/wager-transaction';
import { WagerTransactionKind } from '../../src/domain/wagering/wager-transaction-kind';
import { WagerTransactionStatus } from '../../src/domain/wagering/wager-transaction-status';
import { LedgerDirection } from '../../src/domain/wallet/ledger-direction';
import { NOW, brl, openWallet, tx } from './fixtures';

const later = new Date(NOW.getTime() + 1_000);

describe('WagerTransaction', () => {
  describe('create', () => {
    it('is born PENDING', () => {
      const transaction = tx(openWallet(), WagerTransactionKind.Bet, '10.00');
      expect(transaction.status).toBe(WagerTransactionStatus.Pending);
      expect(transaction.isTerminal()).toBe(false);
    });

    it.each([WagerTransactionKind.Refund, WagerTransactionKind.Rollback])(
      '%s requires a reference',
      (kind) => {
        expect(() => tx(openWallet(), kind, '10.00')).toThrow(InvalidTransactionError);
        expect(tx(openWallet(), kind, '10.00', { reference: 'bet-1' }).requiresReference()).toBe(true);
      },
    );

    it('cannot be created as OPENING', () => {
      expect(() => tx(openWallet(), WagerTransactionKind.Opening, '10.00')).toThrow(
        InvalidTransactionError,
      );
    });

    it('cannot reference itself', () => {
      expect(() =>
        tx(openWallet(), WagerTransactionKind.Refund, '10.00', {
          externalTransactionId: 'same',
          reference: 'same',
        }),
      ).toThrow(InvalidTransactionError);
    });

    it('accepts a zero amount only for LOSS', () => {
      expect(tx(openWallet(), WagerTransactionKind.Loss, '0').money.isZero()).toBe(true);
      expect(() => tx(openWallet(), WagerTransactionKind.Bet, '0')).toThrow(InvalidAmountError);
      expect(() => tx(openWallet(), WagerTransactionKind.Win, '0.00')).toThrow(InvalidAmountError);
    });
  });

  describe('transitions', () => {
    it('PENDING -> PROCESSED records reference, time and observed balance', () => {
      const transaction = tx(openWallet(), WagerTransactionKind.Bet, '10.00');
      transaction.markProcessed('ref-id', later, brl('90.00'));
      expect(transaction.status).toBe(WagerTransactionStatus.Processed);
      expect(transaction.referenceTransactionId).toBe('ref-id');
      expect(transaction.processedAt).toEqual(later);
      expect(transaction.resultBalance!.equals(brl('90.00'))).toBe(true);
      expect(transaction.isTerminal()).toBe(true);
    });

    it('PENDING -> PENDING_REFERENCE -> PENDING_REFERENCE -> PROCESSED counts attempts', () => {
      const transaction = tx(openWallet(), WagerTransactionKind.Refund, '10.00', { reference: 'bet' });
      transaction.markPendingReference(later, NOW);
      transaction.markPendingReference(later, NOW);
      expect(transaction.status).toBe(WagerTransactionStatus.PendingReference);
      expect(transaction.referenceAttempts).toBe(2);
      expect(transaction.nextReferenceAttemptAt).toEqual(later);

      transaction.markProcessed('bet-id', later, brl('110.00'));
      expect(transaction.status).toBe(WagerTransactionStatus.Processed);
      expect(transaction.nextReferenceAttemptAt).toBeUndefined();
    });

    it('PENDING -> REJECTED keeps the failure code', () => {
      const transaction = tx(openWallet(), WagerTransactionKind.Bet, '10.00');
      transaction.reject(FailureCode.InsufficientFunds, later, brl('5.00'));
      expect(transaction.status).toBe(WagerTransactionStatus.Rejected);
      expect(transaction.failureCode).toBe(FailureCode.InsufficientFunds);
    });

    it('PENDING_REFERENCE -> FAILED is auditable', () => {
      const transaction = tx(openWallet(), WagerTransactionKind.Refund, '10.00', { reference: 'bet' });
      transaction.markPendingReference(later, NOW);
      transaction.fail(FailureCode.ProcessingError, later);
      expect(transaction.status).toBe(WagerTransactionStatus.Failed);
      expect(transaction.failureCode).toBe(FailureCode.ProcessingError);
    });

    const terminalStates: Array<[string, (t: WagerTransaction) => void]> = [
      ['PROCESSED', (t) => t.markProcessed(undefined, later, brl('1.00'))],
      ['REJECTED', (t) => t.reject(FailureCode.InsufficientFunds, later, brl('1.00'))],
      ['FAILED', (t) => t.fail(FailureCode.ProcessingError, later)],
    ];
    const transitions: Array<[string, (t: WagerTransaction) => void]> = [
      ['markProcessed', (t) => t.markProcessed(undefined, later, brl('1.00'))],
      ['markPendingReference', (t) => t.markPendingReference(later, later)],
      ['reject', (t) => t.reject(FailureCode.InsufficientFunds, later, brl('1.00'))],
      ['fail', (t) => t.fail(FailureCode.ProcessingError, later)],
    ];

    for (const [state, reach] of terminalStates) {
      for (const [name, transition] of transitions) {
        it(`${state} is terminal: ${name} throws`, () => {
          const transaction = tx(openWallet(), WagerTransactionKind.Bet, '10.00');
          reach(transaction);
          expect(() => transition(transaction)).toThrow(InvalidTransactionStateError);
        });
      }
    }
  });

  describe('domain queries', () => {
    it('LOSS does not affect balance', () => {
      expect(tx(openWallet(), WagerTransactionKind.Loss, '0').affectsBalance()).toBe(false);
      expect(tx(openWallet(), WagerTransactionKind.Bet, '1.00').affectsBalance()).toBe(true);
    });

    it('matches payload by hash', () => {
      const transaction = tx(openWallet(), WagerTransactionKind.Bet, '1.00');
      expect(transaction.matchesPayload('hash')).toBe(true);
      expect(transaction.matchesPayload('other')).toBe(false);
    });

    it('derives ledger direction per kind', () => {
      const wallet = openWallet();
      const bet = tx(wallet, WagerTransactionKind.Bet, '1.00');
      const win = tx(wallet, WagerTransactionKind.Win, '1.00');
      const refund = tx(wallet, WagerTransactionKind.Refund, '1.00', { reference: 'x' });
      const rollback = tx(wallet, WagerTransactionKind.Rollback, '1.00', { reference: 'x' });

      expect(bet.ledgerDirectionFor()).toBe(LedgerDirection.Debit);
      expect(win.ledgerDirectionFor()).toBe(LedgerDirection.Credit);
      expect(refund.ledgerDirectionFor()).toBe(LedgerDirection.Credit);
      expect(rollback.ledgerDirectionFor(bet)).toBe(LedgerDirection.Credit);
      expect(rollback.ledgerDirectionFor(win)).toBe(LedgerDirection.Debit);
      expect(rollback.ledgerDirectionFor(refund)).toBe(LedgerDirection.Debit);
      expect(() => rollback.ledgerDirectionFor()).toThrow(InvalidTransactionError);
      expect(() => tx(wallet, WagerTransactionKind.Loss, '0').ledgerDirectionFor()).toThrow(
        InvalidTransactionError,
      );
    });
  });

  it('builds a processed OPENING transaction', () => {
    const wallet = openWallet();
    const opening = WagerTransaction.opening({
      walletId: wallet.id,
      playerId: wallet.playerId,
      money: brl('1000.00'),
      payloadHash: 'h',
      at: NOW,
    });
    expect(opening.kind).toBe(WagerTransactionKind.Opening);
    expect(opening.status).toBe(WagerTransactionStatus.Processed);
    expect(opening.resultBalance!.equals(brl('1000.00'))).toBe(true);
    expect(() =>
      WagerTransaction.opening({ ...opening, walletId: wallet.id, money: Money.zero('BRL'), at: NOW }),
    ).toThrow(InvalidAmountError);
  });
});
