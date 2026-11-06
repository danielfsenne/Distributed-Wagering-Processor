import { Decimal as BaseDecimal } from 'decimal.js';
import { CurrencyMismatchError, InvalidMoneyError } from './domain-error';

const Decimal = BaseDecimal.clone({ precision: 40, rounding: BaseDecimal.ROUND_HALF_EVEN });
type Decimal = InstanceType<typeof Decimal>;

export const MONEY_SCALE = 2;
const MAX_INTEGER_DIGITS = 18;

const AMOUNT_PATTERN = /^(0|[1-9]\d*)(\.\d{1,2})?$/;
const SIGNED_AMOUNT_PATTERN = /^-?(0|[1-9]\d*)(\.\d{1,2})?$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;

export interface MoneyProps {
  amount: string;
  currency: string;
}

export class Money {
  private constructor(
    private readonly value: Decimal,
    public readonly currency: string,
  ) {}

  static from(props: MoneyProps): Money {
    return Money.parse(props, AMOUNT_PATTERN);
  }

  static fromSigned(props: MoneyProps): Money {
    return Money.parse(props, SIGNED_AMOUNT_PATTERN);
  }

  static zero(currency: string): Money {
    return new Money(new Decimal(0), Money.assertCurrency(currency));
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.value.plus(other.value), this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.value.minus(other.value), this.currency);
  }

  negate(): Money {
    return new Money(this.value.negated(), this.currency);
  }

  isZero(): boolean {
    return this.value.isZero();
  }

  isPositive(): boolean {
    return this.value.greaterThan(0);
  }

  isNegative(): boolean {
    return this.value.lessThan(0);
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.value.lessThan(other.value);
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.value.equals(other.value);
  }

  get amount(): string {
    return this.value.isZero() ? '0.00' : this.value.toFixed(MONEY_SCALE);
  }

  toJSON(): MoneyProps {
    return { amount: this.amount, currency: this.currency };
  }

  toString(): string {
    return `${this.amount} ${this.currency}`;
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new CurrencyMismatchError(this.currency, other.currency);
    }
  }

  private static parse(props: MoneyProps, pattern: RegExp): Money {
    const amount: unknown = props?.amount;
    if (typeof amount !== 'string') {
      throw new InvalidMoneyError('amount must be a decimal string');
    }
    if (!pattern.test(amount)) {
      throw new InvalidMoneyError(
        `amount "${amount}" must be a plain decimal with at most ${MONEY_SCALE} decimal places`,
      );
    }
    const integerDigits = amount.replace('-', '').split('.')[0]!.length;
    if (integerDigits > MAX_INTEGER_DIGITS) {
      throw new InvalidMoneyError(`amount exceeds ${MAX_INTEGER_DIGITS} integer digits`);
    }
    return new Money(new Decimal(amount), Money.assertCurrency(props.currency));
  }

  private static assertCurrency(currency: unknown): string {
    if (typeof currency !== 'string' || !CURRENCY_PATTERN.test(currency)) {
      throw new InvalidMoneyError('currency must be an ISO-4217 code (3 uppercase letters)');
    }
    return currency;
  }
}
