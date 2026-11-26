import { describe, expect, it } from 'vitest';
import { MAX_AMOUNT, formatAmount, parseAmount } from '../amounts';

describe('parseAmount', () => {
  it('converts typed text to the smallest unit', () => {
    expect(parseAmount('17', 2)).toEqual({ ok: true, value: 1700n });
    expect(parseAmount('17.5', 2)).toEqual({ ok: true, value: 1750n });
    expect(parseAmount(' 0.01 ', 2)).toEqual({ ok: true, value: 1n });
    expect(parseAmount('29', 0)).toEqual({ ok: true, value: 29n });
  });

  it('rejects more decimal places than the token has', () => {
    expect(parseAmount('1.234', 2)).toMatchObject({ ok: false });
    expect(parseAmount('1.5', 0)).toMatchObject({ ok: false });
  });

  it('rejects zero, negatives, text and amounts that do not fit in 64 bits', () => {
    for (const text of ['', '0', '0.00', '-1', 'abc', '1e3', '1,5', '.5']) {
      expect(parseAmount(text, 2), text).toMatchObject({ ok: false });
    }
    expect(parseAmount(MAX_AMOUNT.toString(), 0)).toEqual({ ok: true, value: MAX_AMOUNT });
    expect(parseAmount((MAX_AMOUNT + 1n).toString(), 0)).toMatchObject({ ok: false });
  });
});

describe('formatAmount', () => {
  it('shows the smallest unit as readable text', () => {
    expect(formatAmount(1700n, 2)).toBe('17');
    expect(formatAmount(1750n, 2)).toBe('17.5');
    expect(formatAmount(1n, 2)).toBe('0.01');
    expect(formatAmount(0n, 2)).toBe('0');
    expect(formatAmount(54n, 0)).toBe('54');
  });

  it('round-trips with parseAmount', () => {
    for (const text of ['100', '17', '29', '54', '0.05', '123456.78']) {
      const parsed = parseAmount(text, 2);
      expect(parsed.ok && formatAmount(parsed.value, 2)).toBe(text);
    }
  });
});
