import {
  CurrencyMismatchError,
  InsufficientFundsError,
  InvalidAmountError,
} from '../shared/domain-error';
import { Money } from '../shared/money';
import { LedgerDirection } from './ledger-direction';
import { WalletLedgerEntry } from './wallet-ledger-entry';

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface OpenWalletProps {
  id: string;
  playerId: string;
  initialBalance: Money;
  openingTransactionId?: string | undefined;
  at: Date;
}

export interface OpenedWallet {
  wallet: Wallet;
  openingEntry: WalletLedgerEntry | undefined;
}

export interface MovementContext {
  transactionId: string;
  at: Date;
}

export class Wallet {
  static readonly INITIAL_VERSION = 1;

  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private _balance: Money,
    private _version: number,
    public readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  static open(props: OpenWalletProps): OpenedWallet {
    if (props.initialBalance.isNegative()) {
      throw new InvalidAmountError('initial balance cannot be negative');
    }
    if (props.initialBalance.isPositive() && !props.openingTransactionId) {
      throw new InvalidAmountError('a positive initial balance requires an opening transaction');
    }
    const currency = props.initialBalance.currency;
    const wallet = new Wallet(
      props.id,
      props.playerId,
      currency,
      props.initialBalance,
      Wallet.INITIAL_VERSION,
      props.at,
      props.at,
    );
    const openingEntry = props.initialBalance.isPositive()
      ? WalletLedgerEntry.create({
          walletId: wallet.id,
          transactionId: props.openingTransactionId!,
          direction: LedgerDirection.Credit,
          money: props.initialBalance,
          balanceBefore: Money.zero(currency),
          balanceAfter: props.initialBalance,
          walletVersion: Wallet.INITIAL_VERSION,
          createdAt: props.at,
        })
      : undefined;
    return { wallet, openingEntry };
  }

  static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id,
      state.playerId,
      state.currency,
      state.balance,
      state.version,
      state.createdAt,
      state.updatedAt,
    );
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get updatedAt(): Date {
    return this._updatedAt;
  }

  canDebit(money: Money): boolean {
    this.assertSameCurrency(money);
    return !this._balance.isLessThan(money);
  }

  debit(money: Money, context: MovementContext): WalletLedgerEntry {
    this.assertMovable(money);
    if (!this.canDebit(money)) {
      throw new InsufficientFundsError(this.id);
    }
    return this.move(LedgerDirection.Debit, money, context);
  }

  credit(money: Money, context: MovementContext): WalletLedgerEntry {
    this.assertMovable(money);
    return this.move(LedgerDirection.Credit, money, context);
  }

  apply(direction: LedgerDirection, money: Money, context: MovementContext): WalletLedgerEntry {
    return direction === LedgerDirection.Debit
      ? this.debit(money, context)
      : this.credit(money, context);
  }

  toState(): WalletState {
    return {
      id: this.id,
      playerId: this.playerId,
      currency: this.currency,
      balance: this._balance,
      version: this._version,
      createdAt: this.createdAt,
      updatedAt: this._updatedAt,
    };
  }

  private move(
    direction: LedgerDirection,
    money: Money,
    context: MovementContext,
  ): WalletLedgerEntry {
    const balanceBefore = this._balance;
    const balanceAfter =
      direction === LedgerDirection.Credit ? balanceBefore.add(money) : balanceBefore.subtract(money);
    const entry = WalletLedgerEntry.create({
      walletId: this.id,
      transactionId: context.transactionId,
      direction,
      money,
      balanceBefore,
      balanceAfter,
      walletVersion: this._version + 1,
      createdAt: context.at,
    });
    this._balance = balanceAfter;
    this._version = entry.walletVersion;
    this._updatedAt = context.at;
    return entry;
  }

  private assertMovable(money: Money): void {
    this.assertSameCurrency(money);
    if (!money.isPositive()) {
      throw new InvalidAmountError('movement amount must be positive');
    }
  }

  private assertSameCurrency(money: Money): void {
    if (money.currency !== this.currency) {
      throw new CurrencyMismatchError(this.currency, money.currency);
    }
  }
}
