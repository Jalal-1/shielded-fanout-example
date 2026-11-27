import { describe, expect, it } from 'vitest';
import { RECIPIENTS_PER_TRANSACTION, inBatches, totalOf, type Payment } from '../fanout';

const list = (count: number): Payment[] =>
  Array.from({ length: count }, (_, index) => ({ recipient: `wallet-${index}`, amount: BigInt(index + 1) }));

describe('inBatches', () => {
  it('keeps a list that fits in one transaction whole', () => {
    expect(inBatches(list(RECIPIENTS_PER_TRANSACTION))).toHaveLength(1);
  });

  it('cuts a long list into transactions of 64, in order, losing nobody', () => {
    const payments = list(2000);
    const batches = inBatches(payments);
    expect(batches.map((batch) => batch.length)).toEqual([...Array(31).fill(64), 16]);
    expect(batches.flat()).toEqual(payments);
    expect(batches.reduce((sum, batch) => sum + totalOf(batch), 0n)).toBe(totalOf(payments));
  });

  it('gives no transactions for an empty list', () => {
    expect(inBatches([])).toEqual([]);
  });
});
