import { describe, expect, it } from 'bun:test';
import {
  CurrencyMismatchError,
  InsufficientFundsError,
  InvalidAmountError,
  UnbalancedLedgerEntryError,
} from '../../src/domain/shared/domain-error';
import { newId } from '../../src/domain/shared/id';
import { Money } from '../../src/domain/shared/money';
import { LedgerDirection } from '../../src/domain/wallet/ledger-direction';
import { Wallet } from '../../src/domain/wallet/wallet';
import { WalletLedgerEntry } from '../../src/domain/wallet/wallet-ledger-entry';
import { NOW, PLAYER_ID, brl, openWallet, usd } from './fixtures';

const context = () => ({ transactionId: newId(), at: NOW });

function replay(entries: WalletLedgerEntry[], currency = 'BRL'): Money {
  return entries.reduce((total, entry) => total.add(entry.signedAmount()), Money.zero(currency));
}

describe('Wallet', () => {
  describe('open', () => {
    it('starts at version 1 with an opening credit entry when the balance is positive', () => {
      const openingTransactionId = newId();
      const { wallet, openingEntry } = Wallet.open({
        id: newId(),
        playerId: PLAYER_ID,
        initialBalance: brl('1000.00'),
        openingTransactionId,
        at: NOW,
      });

      expect(wallet.version).toBe(1);
      expect(wallet.currency).toBe('BRL');
      expect(wallet.balance.equals(brl('1000.00'))).toBe(true);
      expect(openingEntry).toBeDefined();
      expect(openingEntry!.direction).toBe(LedgerDirection.Credit);
      expect(openingEntry!.transactionId).toBe(openingTransactionId);
      expect(openingEntry!.balanceBefore.isZero()).toBe(true);
      expect(openingEntry!.balanceAfter.equals(wallet.balance)).toBe(true);
      expect(openingEntry!.walletVersion).toBe(1);
    });

    it('has no opening entry for a zero initial balance', () => {
      const { wallet, openingEntry } = Wallet.open({
        id: newId(),
        playerId: PLAYER_ID,
        initialBalance: Money.zero('BRL'),
        openingTransactionId: newId(),
        at: NOW,
      });
      expect(wallet.version).toBe(1);
      expect(openingEntry).toBeUndefined();
    });

    it('rejects a negative initial balance', () => {
      expect(() =>
        Wallet.open({
          id: newId(),
          playerId: PLAYER_ID,
          initialBalance: Money.fromSigned({ amount: '-1.00', currency: 'BRL' }),
          openingTransactionId: newId(),
          at: NOW,
        }),
      ).toThrow(InvalidAmountError);
    });
  });

  describe('debit and credit', () => {
    it('debits, increments version and returns a balanced entry', () => {
      const wallet = openWallet('100.00');
      const entry = wallet.debit(brl('80.00'), context());

      expect(wallet.balance.equals(brl('20.00'))).toBe(true);
      expect(wallet.version).toBe(2);
      expect(entry.direction).toBe(LedgerDirection.Debit);
      expect(entry.balanceBefore.equals(brl('100.00'))).toBe(true);
      expect(entry.balanceAfter.equals(brl('20.00'))).toBe(true);
      expect(entry.walletVersion).toBe(2);
      expect(entry.isBalanced()).toBe(true);
    });

    it('credits and increments version', () => {
      const wallet = openWallet('0');
      const entry = wallet.credit(brl('12.34'), context());
      expect(wallet.balance.equals(brl('12.34'))).toBe(true);
      expect(wallet.version).toBe(2);
      expect(entry.direction).toBe(LedgerDirection.Credit);
    });

    it('allows debiting the entire balance down to zero', () => {
      const wallet = openWallet('80.00');
      wallet.debit(brl('80.00'), context());
      expect(wallet.balance.isZero()).toBe(true);
    });

    it('never goes negative and leaves state untouched on insufficient funds', () => {
      const wallet = openWallet('100.00');
      wallet.debit(brl('80.00'), context());

      expect(() => wallet.debit(brl('80.00'), context())).toThrow(InsufficientFundsError);
      expect(wallet.balance.equals(brl('20.00'))).toBe(true);
      expect(wallet.version).toBe(2);
    });

    it('rejects operations in another currency without changing state', () => {
      const wallet = openWallet('100.00');
      expect(() => wallet.debit(usd('1.00'), context())).toThrow(CurrencyMismatchError);
      expect(() => wallet.credit(usd('1.00'), context())).toThrow(CurrencyMismatchError);
      expect(wallet.version).toBe(1);
      expect(wallet.balance.equals(brl('100.00'))).toBe(true);
    });

    it('rejects zero movements', () => {
      const wallet = openWallet('100.00');
      expect(() => wallet.credit(Money.zero('BRL'), context())).toThrow(InvalidAmountError);
      expect(() => wallet.debit(Money.zero('BRL'), context())).toThrow(InvalidAmountError);
    });

    it('keeps balance equal to the balance rebuilt from its ledger', () => {
      const { wallet, openingEntry } = Wallet.open({
        id: newId(),
        playerId: PLAYER_ID,
        initialBalance: brl('50.00'),
        openingTransactionId: newId(),
        at: NOW,
      });
      const entries = [openingEntry!];
      entries.push(wallet.debit(brl('10.00'), context()));
      entries.push(wallet.credit(brl('35.55'), context()));
      entries.push(wallet.debit(brl('0.55'), context()));

      expect(replay(entries).equals(wallet.balance)).toBe(true);
      expect(entries.map((entry) => entry.walletVersion)).toEqual([1, 2, 3, 4]);
      for (let i = 1; i < entries.length; i++) {
        expect(entries[i]!.balanceBefore.equals(entries[i - 1]!.balanceAfter)).toBe(true);
      }
    });
  });

  it('rehydrates without revalidating', () => {
    const state = openWallet('10.00').toState();
    const wallet = Wallet.rehydrate({ ...state, version: 7 });
    expect(wallet.version).toBe(7);
    expect(wallet.balance.equals(brl('10.00'))).toBe(true);
  });
});

describe('WalletLedgerEntry', () => {
  const base = {
    walletId: newId(),
    transactionId: newId(),
    walletVersion: 2,
    createdAt: NOW,
  };

  it('validates the arithmetic in the factory', () => {
    expect(() =>
      WalletLedgerEntry.create({
        ...base,
        direction: LedgerDirection.Credit,
        money: brl('10.00'),
        balanceBefore: brl('5.00'),
        balanceAfter: brl('14.99'),
      }),
    ).toThrow(UnbalancedLedgerEntryError);
  });

  it('rejects negative balances and non-positive amounts', () => {
    expect(() =>
      WalletLedgerEntry.create({
        ...base,
        direction: LedgerDirection.Debit,
        money: brl('10.00'),
        balanceBefore: brl('5.00'),
        balanceAfter: Money.fromSigned({ amount: '-5.00', currency: 'BRL' }),
      }),
    ).toThrow(UnbalancedLedgerEntryError);
    expect(() =>
      WalletLedgerEntry.create({
        ...base,
        direction: LedgerDirection.Credit,
        money: Money.zero('BRL'),
        balanceBefore: brl('5.00'),
        balanceAfter: brl('5.00'),
      }),
    ).toThrow(UnbalancedLedgerEntryError);
  });

  it('is structurally immutable', () => {
    const entry = WalletLedgerEntry.create({
      ...base,
      direction: LedgerDirection.Credit,
      money: brl('10.00'),
      balanceBefore: brl('5.00'),
      balanceAfter: brl('15.00'),
    });
    expect(Object.isFrozen(entry)).toBe(true);
    expect(() => {
      (entry as unknown as { direction: string }).direction = LedgerDirection.Debit;
    }).toThrow();
  });
});
