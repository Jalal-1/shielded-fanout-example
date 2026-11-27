import { describe, expect, it } from 'vitest';
import {
  MidnightBech32m,
  ShieldedAddress,
  ShieldedCoinPublicKey,
  ShieldedEncryptionPublicKey,
} from '@midnightntwrk/wallet-sdk-address-format';
import { parseList } from '../list';

// Addresses made by the wallet SDK's own codec, as in address.test.ts.
const address = (fill: number, networkId = 'preprod'): string =>
  MidnightBech32m.encode(
    networkId,
    new ShieldedAddress(
      new ShieldedCoinPublicKey(Buffer.alloc(32, fill)),
      new ShieldedEncryptionPublicKey(Buffer.alloc(32, fill + 1)),
    ),
  ).asString();

describe('reading a payout list', () => {
  it('reads one payment per line, in order, in the smallest unit', () => {
    const parsed = parseList(`${address(1)} 17\n${address(3)} 2.5\n`, 2, 'preprod');
    expect(parsed.count).toBe(2);
    expect(parsed.firstProblem).toBeUndefined();
    expect(parsed.payments).toEqual([
      { recipient: address(1), amount: 1700n },
      { recipient: address(3), amount: 250n },
    ]);
  });

  it('skips empty lines and takes a comma or a semicolon between address and amount', () => {
    const parsed = parseList(`\n  ${address(1)},1\n\n${address(3)}; 2\n`, 0, 'preprod');
    expect(parsed.payments.map((payment) => payment.amount)).toEqual([1n, 2n]);
  });

  it('names the first line that cannot be paid, and pays nothing', () => {
    const missingAmount = parseList(`${address(1)} 1\n${address(3)}\n`, 0, 'preprod');
    expect(missingAmount.firstProblem).toEqual({ index: 1, problem: 'Add the amount after the address.' });
    expect(missingAmount.payments).toEqual([]);

    const otherNetwork = parseList(`${address(1, 'preview')} 1`, 0, 'preprod');
    expect(otherNetwork.firstProblem?.index).toBe(0);
    expect(otherNetwork.firstProblem?.problem).toMatch(/another network/);
  });

  it('has nothing to pay in an empty text', () => {
    expect(parseList(' \n\n', 2, 'preprod')).toEqual({ count: 0, payments: [] });
  });
});
