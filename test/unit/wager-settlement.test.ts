import { describe, expect, it } from 'bun:test';
import { newId } from '../../src/domain/shared/id';
import { Money } from '../../src/domain/shared/money';
import { FailureCode } from '../../src/domain/wagering/failure-code';
import { WagerSettlement } from '../../src/domain/wagering/wager-settlement';
import { WagerTransaction } from '../../src/domain/wagering/wager-transaction';
import { WagerTransactionKind as Kind } from '../../src/domain/wagering/wager-transaction-kind';
import { WagerTransactionStatus as Status } from '../../src/domain/wagering/wager-transaction-status';
import { LedgerDirection } from '../../src/domain/wallet/ledger-direction';
import { Wallet } from '../../src/domain/wallet/wallet';
import { NOW, brl, openWallet, retryPolicy, tx, usd } from './fixtures';

function settle(
  wallet: Wallet,
  transaction: WagerTransaction,
  reference?: WagerTransaction,
  referenceAlreadyReversed = false,
) {
  return WagerSettlement.settle({
    transaction,
    wallet,
    reference,
    referenceAlreadyReversed,
    retryPolicy,
    at: NOW,
  });
}

function processed(wallet: Wallet, kind: Kind, amount: string, reference?: WagerTransaction) {
  const transaction = tx(wallet, kind, amount, {
    reference: reference?.externalTransactionId,
  });
  settle(wallet, transaction, reference);
  expect(transaction.status).toBe(Status.Processed);
  return transaction;
}

describe('WagerSettlement', () => {
  describe('BET', () => {
    it('debits the wallet with one DEBIT entry', () => {
      const wallet = openWallet('100.00');
      const bet = tx(wallet, Kind.Bet, '25.00');
      const { entry } = settle(wallet, bet);

      expect(bet.status).toBe(Status.Processed);
      expect(entry!.direction).toBe(LedgerDirection.Debit);
      expect(wallet.balance.equals(brl('75.00'))).toBe(true);
      expect(bet.resultBalance!.equals(brl('75.00'))).toBe(true);
    });

    it('is rejected with INSUFFICIENT_FUNDS without touching the wallet', () => {
      const wallet = openWallet('100.00');
      processed(wallet, Kind.Bet, '80.00');
      const second = tx(wallet, Kind.Bet, '80.00');
      const { entry } = settle(wallet, second);

      expect(second.status).toBe(Status.Rejected);
      expect(second.failureCode).toBe(FailureCode.InsufficientFunds);
      expect(entry).toBeUndefined();
      expect(wallet.balance.equals(brl('20.00'))).toBe(true);
      expect(wallet.version).toBe(2);
      expect(second.resultBalance!.equals(brl('20.00'))).toBe(true);
    });

    it('is rejected on currency mismatch', () => {
      const wallet = openWallet('100.00');
      const bet = tx(wallet, Kind.Bet, '1.00', { money: usd('1.00') });
      settle(wallet, bet);
      expect(bet.failureCode).toBe(FailureCode.CurrencyMismatch);
      expect(wallet.version).toBe(1);
    });

    it('is rejected when the player does not own the wallet', () => {
      const wallet = openWallet('100.00');
      const bet = tx(wallet, Kind.Bet, '1.00', { playerId: newId() });
      settle(wallet, bet);
      expect(bet.failureCode).toBe(FailureCode.PlayerWalletMismatch);
    });
  });

  describe('WIN', () => {
    it('credits the wallet without reference', () => {
      const wallet = openWallet('10.00');
      const { entry } = settle(wallet, tx(wallet, Kind.Win, '50.00'));
      expect(entry!.direction).toBe(LedgerDirection.Credit);
      expect(wallet.balance.equals(brl('60.00'))).toBe(true);
    });

    it('may reference the BET of the same round', () => {
      const wallet = openWallet('10.00');
      const bet = processed(wallet, Kind.Bet, '10.00');
      const win = processed(wallet, Kind.Win, '30.00', bet);
      expect(win.referenceTransactionId).toBe(bet.id);
      expect(wallet.balance.equals(brl('30.00'))).toBe(true);
    });

    it('is rejected when the referenced BET is from another round', () => {
      const wallet = openWallet('10.00');
      const bet = processed(wallet, Kind.Bet, '10.00');
      const win = tx(wallet, Kind.Win, '30.00', { reference: bet.externalTransactionId, roundId: 'r2' });
      settle(wallet, win, bet);
      expect(win.failureCode).toBe(FailureCode.ReferenceMismatch);
    });
  });

  describe('LOSS', () => {
    it('is processed without moving balance or creating a ledger entry', () => {
      const wallet = openWallet('10.00');
      const bet = processed(wallet, Kind.Bet, '10.00');
      const loss = tx(wallet, Kind.Loss, '0', { reference: bet.externalTransactionId });
      const { entry } = settle(wallet, loss, bet);

      expect(loss.status).toBe(Status.Processed);
      expect(entry).toBeUndefined();
      expect(wallet.version).toBe(2);
      expect(loss.resultBalance!.isZero()).toBe(true);
    });
  });

  describe('REFUND', () => {
    it('credits back a processed BET', () => {
      const wallet = openWallet('100.00');
      const bet = processed(wallet, Kind.Bet, '40.00');
      const refund = processed(wallet, Kind.Refund, '40.00', bet);
      expect(refund.referenceTransactionId).toBe(bet.id);
      expect(wallet.balance.equals(brl('100.00'))).toBe(true);
    });

    it('only references BET', () => {
      const wallet = openWallet('100.00');
      const win = processed(wallet, Kind.Win, '40.00');
      const refund = tx(wallet, Kind.Refund, '40.00', { reference: win.externalTransactionId });
      settle(wallet, refund, win);
      expect(refund.failureCode).toBe(FailureCode.ReferenceKindNotAllowed);
    });

    it('requires the same amount as the reference', () => {
      const wallet = openWallet('100.00');
      const bet = processed(wallet, Kind.Bet, '40.00');
      const refund = tx(wallet, Kind.Refund, '39.99', { reference: bet.externalTransactionId });
      settle(wallet, refund, bet);
      expect(refund.failureCode).toBe(FailureCode.ReferenceAmountMismatch);
      expect(wallet.balance.equals(brl('60.00'))).toBe(true);
    });

    it('cannot reverse the same reference twice', () => {
      const wallet = openWallet('100.00');
      const bet = processed(wallet, Kind.Bet, '40.00');
      const refund = tx(wallet, Kind.Refund, '40.00', { reference: bet.externalTransactionId });
      settle(wallet, refund, bet, true);
      expect(refund.failureCode).toBe(FailureCode.AlreadyReversed);
    });

    it('rejects when the reference was rejected', () => {
      const wallet = openWallet('10.00');
      const bet = tx(wallet, Kind.Bet, '40.00');
      settle(wallet, bet);
      expect(bet.status).toBe(Status.Rejected);

      const refund = tx(wallet, Kind.Refund, '40.00', { reference: bet.externalTransactionId });
      settle(wallet, refund, bet);
      expect(refund.failureCode).toBe(FailureCode.ReferenceNotProcessed);
    });

    it('rejects a reference belonging to another wallet', () => {
      const wallet = openWallet('100.00');
      const otherWallet = openWallet('100.00');
      const foreignBet = processed(otherWallet, Kind.Bet, '10.00');
      const refund = tx(wallet, Kind.Refund, '10.00', { reference: foreignBet.externalTransactionId });
      settle(wallet, refund, foreignBet);
      expect(refund.failureCode).toBe(FailureCode.ReferenceMismatch);
    });
  });

  describe('ROLLBACK', () => {
    it('credits back a BET', () => {
      const wallet = openWallet('100.00');
      const bet = processed(wallet, Kind.Bet, '30.00');
      const { entry } = settle(wallet, tx(wallet, Kind.Rollback, '30.00', { reference: bet.externalTransactionId }), bet);
      expect(entry!.direction).toBe(LedgerDirection.Credit);
      expect(wallet.balance.equals(brl('100.00'))).toBe(true);
    });

    it('debits back a WIN', () => {
      const wallet = openWallet('0');
      const win = processed(wallet, Kind.Win, '30.00');
      const { entry } = settle(wallet, tx(wallet, Kind.Rollback, '30.00', { reference: win.externalTransactionId }), win);
      expect(entry!.direction).toBe(LedgerDirection.Debit);
      expect(wallet.balance.isZero()).toBe(true);
    });

    it('debits back a REFUND', () => {
      const wallet = openWallet('100.00');
      const bet = processed(wallet, Kind.Bet, '30.00');
      const refund = processed(wallet, Kind.Refund, '30.00', bet);
      processed(wallet, Kind.Rollback, '30.00', refund);
      expect(wallet.balance.equals(brl('70.00'))).toBe(true);
    });

    it('is rejected with a distinct code when the reversal would make the balance negative', () => {
      const wallet = openWallet('0');
      const win = processed(wallet, Kind.Win, '30.00');
      processed(wallet, Kind.Bet, '20.00');
      const rollback = tx(wallet, Kind.Rollback, '30.00', { reference: win.externalTransactionId });
      settle(wallet, rollback, win);

      expect(rollback.status).toBe(Status.Rejected);
      expect(rollback.failureCode).toBe(FailureCode.ReversalInsufficientFunds);
      expect(rollback.failureCode).not.toBe(FailureCode.InsufficientFunds);
      expect(wallet.balance.equals(brl('10.00'))).toBe(true);
    });

    it('cannot reference a LOSS', () => {
      const wallet = openWallet('10.00');
      const loss = processed(wallet, Kind.Loss, '0');
      const rollback = tx(wallet, Kind.Rollback, '1.00', { reference: loss.externalTransactionId });
      settle(wallet, rollback, loss);
      expect(rollback.failureCode).toBe(FailureCode.ReferenceKindNotAllowed);
    });
  });

  describe('out-of-order references', () => {
    it('waits as PENDING_REFERENCE with exponential backoff', () => {
      const wallet = openWallet('100.00');
      const refund = tx(wallet, Kind.Refund, '10.00', { reference: 'bet-not-yet-arrived' });

      settle(wallet, refund);
      expect(refund.status).toBe(Status.PendingReference);
      expect(refund.referenceAttempts).toBe(1);
      expect(refund.nextReferenceAttemptAt).toEqual(new Date(NOW.getTime() + 1_000));

      settle(wallet, refund);
      expect(refund.referenceAttempts).toBe(2);
      expect(refund.nextReferenceAttemptAt).toEqual(new Date(NOW.getTime() + 2_000));
      expect(wallet.version).toBe(1);
    });

    it('is processed once the reference arrives', () => {
      const wallet = openWallet('100.00');
      const refund = tx(wallet, Kind.Refund, '10.00', { reference: 'late-bet' });
      settle(wallet, refund);

      const bet = tx(wallet, Kind.Bet, '10.00', { externalTransactionId: 'late-bet' });
      settle(wallet, bet);
      settle(wallet, refund, bet);

      expect(refund.status).toBe(Status.Processed);
      expect(wallet.balance.equals(brl('100.00'))).toBe(true);
    });

    it('keeps waiting while the reference itself is pending', () => {
      const wallet = openWallet('100.00');
      const win = tx(wallet, Kind.Win, '10.00', { reference: 'missing-bet' });
      settle(wallet, win);
      const rollback = tx(wallet, Kind.Rollback, '10.00', { reference: win.externalTransactionId });
      settle(wallet, rollback, win);
      expect(rollback.status).toBe(Status.PendingReference);
    });

    it('is rejected with REFERENCE_NOT_FOUND after the attempt limit', () => {
      const wallet = openWallet('100.00');
      const refund = tx(wallet, Kind.Refund, '10.00', { reference: 'never' });
      for (let attempt = 1; attempt < retryPolicy.maxAttempts; attempt++) {
        settle(wallet, refund);
        expect(refund.status).toBe(Status.PendingReference);
      }
      settle(wallet, refund);
      expect(refund.status).toBe(Status.Rejected);
      expect(refund.failureCode).toBe(FailureCode.ReferenceNotFound);
      expect(wallet.balance.equals(brl('100.00'))).toBe(true);
    });
  });

  it('keeps wallet.balance equal to the ledger across a full round', () => {
    const { wallet, openingEntry } = Wallet.open({
      id: newId(),
      playerId: openWallet().playerId,
      initialBalance: brl('100.00'),
      openingTransactionId: newId(),
      at: NOW,
    });
    const entries = [openingEntry!];
    const record = (transaction: WagerTransaction, reference?: WagerTransaction) => {
      const { entry } = settle(wallet, transaction, reference);
      if (entry) entries.push(entry);
      return transaction;
    };

    const bet = record(tx(wallet, Kind.Bet, '25.00'));
    const win = record(tx(wallet, Kind.Win, '60.00', { reference: bet.externalTransactionId }), bet);
    record(tx(wallet, Kind.Rollback, '60.00', { reference: win.externalTransactionId }), win);
    const bet2 = record(tx(wallet, Kind.Bet, '10.00'));
    record(tx(wallet, Kind.Refund, '10.00', { reference: bet2.externalTransactionId }), bet2);
    record(tx(wallet, Kind.Bet, '500.00'));
    record(tx(wallet, Kind.Loss, '0'));

    const rebuilt = entries.reduce((sum, entry) => sum.add(entry.signedAmount()), Money.zero('BRL'));
    expect(rebuilt.equals(wallet.balance)).toBe(true);
    expect(wallet.balance.equals(brl('75.00'))).toBe(true);
    expect(wallet.version).toBe(entries.length);
  });
});
