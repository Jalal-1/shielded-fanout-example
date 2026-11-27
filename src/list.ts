// Reading a payout list as it is typed, pasted or loaded from a file.
//
// One wallet per line: its shielded address, then the amount. The two may be
// separated by spaces, a comma or a semicolon, so a CSV export works as it is.
import { checkShieldedAddress } from './address';
import { parseAmount } from './amounts';
import type { Payment } from './fanout';

export interface ParsedList {
  /** How many lines the text has, not counting empty ones. */
  readonly count: number;
  /** The first line that cannot be paid, counted from 0, and why. */
  readonly firstProblem?: { readonly index: number; readonly problem: string };
  /** Every line as a payment, in order. Empty while any line has a problem. */
  readonly payments: Payment[];
}

export function parseList(text: string, decimals: number, networkId: string): ParsedList {
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
  const payments: Payment[] = [];
  for (const [index, line] of lines.entries()) {
    const [address = '', amountText = ''] = line.split(/[\s,;]+/);
    const amount = parseAmount(amountText, decimals);
    const problem =
      checkShieldedAddress(address, networkId) ??
      (amountText === '' ? 'Add the amount after the address.' : amount.ok ? null : amount.error);
    if (problem !== null || !amount.ok) {
      return { count: lines.length, firstProblem: { index, problem: problem ?? 'Enter an amount.' }, payments: [] };
    }
    payments.push({ recipient: address, amount: amount.value });
  }
  return { count: lines.length, payments };
}
