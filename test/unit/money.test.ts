import { describe, expect, it } from 'bun:test';
import { CurrencyMismatchError, InvalidMoneyError } from '../../src/domain/shared/domain-error';
import { Money } from '../../src/domain/shared/money';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });

describe('Money', () => {
  describe('parsing', () => {
    it.each([
      ['25.00', '25.00'],
      ['25', '25.00'],
      ['25.5', '25.50'],
      ['0', '0.00'],
      ['0.01', '0.01'],
      ['999999999999999999.99', '999999999999999999.99'],
    ])('accepts %p and serializes as %p', (input, expected) => {
      expect(brl(input).toJSON()).toEqual({ amount: expected, currency: 'BRL' });
    });

    it.each([
      ['', 'empty string'],
      ['NaN', 'NaN'],
      ['Infinity', 'Infinity'],
      ['-Infinity', 'negative Infinity'],
      ['1e3', 'scientific notation'],
      ['1E-2', 'scientific notation uppercase'],
      ['10.005', 'more than 2 decimal places'],
      ['0.001', 'sub-cent precision'],
      ['-1.00', 'negative value'],
      ['+1.00', 'explicit plus sign'],
      [' 1.00', 'leading whitespace'],
      ['1.00 ', 'trailing whitespace'],
      ['1,00', 'comma separator'],
      ['01.00', 'leading zero'],
      ['.50', 'missing integer part'],
      ['1.', 'dangling decimal point'],
      ['0x10', 'hexadecimal'],
      ['1000000000000000000.00', 'more than 18 integer digits'],
    ])('rejects %p (%s)', (input) => {
      expect(() => brl(input)).toThrow(InvalidMoneyError);
    });

    it('rejects non-string amounts', () => {
      expect(() => Money.from({ amount: 25 as unknown as string, currency: 'BRL' })).toThrow(
        InvalidMoneyError,
      );
    });

    it.each(['brl', 'BR', 'BRLL', '', '123'])('rejects invalid currency %p', (currency) => {
      expect(() => Money.from({ amount: '1.00', currency })).toThrow(InvalidMoneyError);
    });

    it('accepts negative values only through fromSigned', () => {
      expect(Money.fromSigned({ amount: '-12.30', currency: 'BRL' }).toJSON().amount).toBe('-12.30');
      expect(() => Money.fromSigned({ amount: '-1e2', currency: 'BRL' })).toThrow(InvalidMoneyError);
    });
  });

  describe('arithmetic', () => {
    it('is exact where binary floating point is not', () => {
      expect(brl('0.10').add(brl('0.20')).equals(brl('0.30'))).toBe(true);
      expect(brl('1.10').add(brl('2.20')).toJSON().amount).toBe('3.30');
    });

    it('keeps scale 2 without rounding on large sums', () => {
      let total = Money.zero('BRL');
      for (let i = 0; i < 1000; i++) {
        total = total.add(brl('0.01'));
      }
      expect(total.toJSON().amount).toBe('10.00');
      expect(brl('999999999999999998.99').add(brl('1.00')).toJSON().amount).toBe(
        '999999999999999999.99',
      );
    });

    it('subtracts and negates', () => {
      expect(brl('100.00').subtract(brl('80.00')).toJSON().amount).toBe('20.00');
      expect(brl('20.00').subtract(brl('80.00')).toJSON().amount).toBe('-60.00');
      expect(brl('5.00').negate().toJSON().amount).toBe('-5.00');
    });

    it('never serializes negative zero', () => {
      expect(Money.zero('BRL').negate().toJSON().amount).toBe('0.00');
      expect(brl('1.00').subtract(brl('1.00')).toJSON().amount).toBe('0.00');
    });

    it('is immutable', () => {
      const original = brl('10.00');
      original.add(brl('5.00'));
      original.subtract(brl('5.00'));
      original.negate();
      expect(original.toJSON().amount).toBe('10.00');
    });
  });

  describe('comparisons', () => {
    it('reports sign', () => {
      expect(Money.zero('BRL').isZero()).toBe(true);
      expect(brl('0.01').isPositive()).toBe(true);
      expect(brl('0.01').negate().isNegative()).toBe(true);
    });

    it('compares values of the same currency', () => {
      expect(brl('79.99').isLessThan(brl('80.00'))).toBe(true);
      expect(brl('80.00').isLessThan(brl('80.00'))).toBe(false);
      expect(brl('80').equals(brl('80.00'))).toBe(true);
    });

    it('treats different currencies as not equal', () => {
      expect(brl('1.00').equals(Money.from({ amount: '1.00', currency: 'USD' }))).toBe(false);
    });
  });

  describe('currency conflicts', () => {
    const usd = Money.from({ amount: '1.00', currency: 'USD' });

    it.each([
      ['add', () => brl('1.00').add(usd)],
      ['subtract', () => brl('1.00').subtract(usd)],
      ['isLessThan', () => brl('1.00').isLessThan(usd)],
    ])('%s across currencies throws a domain error', (_name, operation) => {
      expect(operation).toThrow(CurrencyMismatchError);
    });
  });

  it('formats as string', () => {
    expect(brl('25').toString()).toBe('25.00 BRL');
  });
});
