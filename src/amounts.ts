// Amounts as people type them ("17.50") and as the chain stores them (1750n).
//
// A token has no fractions on chain. `decimals` is only a display convention:
// with 2 decimals, the smallest unit is one hundredth of a token.

/** The largest amount a single mint or coin can carry (an unsigned 64-bit integer). */
export const MAX_AMOUNT = (1n << 64n) - 1n;

export type ParsedAmount =
  | { readonly ok: true; readonly value: bigint }
  | { readonly ok: false; readonly error: string };

/** Turn typed text into the smallest unit, or say what is wrong with it. */
export function parseAmount(text: string, decimals: number): ParsedAmount {
  const trimmed = text.trim();
  if (trimmed === '') return { ok: false, error: 'Enter an amount.' };
  const match = /^(\d+)(?:\.(\d*))?$/.exec(trimmed);
  if (!match) return { ok: false, error: 'Use digits only, such as 17 or 17.5.' };

  const whole = match[1] ?? '0';
  const fraction = match[2] ?? '';
  if (fraction.length > decimals) {
    return {
      ok: false,
      error: decimals === 0 ? 'This token has no decimal places.' : `At most ${decimals} decimal places.`,
    };
  }

  const value = BigInt(whole + fraction.padEnd(decimals, '0'));
  if (value <= 0n) return { ok: false, error: 'The amount must be above zero.' };
  if (value > MAX_AMOUNT) return { ok: false, error: 'The amount is too large.' };
  return { ok: true, value };
}

/** Turn the smallest unit back into readable text, without trailing zeros. */
export function formatAmount(value: bigint, decimals: number): string {
  const digits = value.toString().padStart(decimals + 1, '0');
  const whole = digits.slice(0, digits.length - decimals);
  const fraction = decimals === 0 ? '' : digits.slice(-decimals).replace(/0+$/, '');
  return fraction === '' ? whole : `${whole}.${fraction}`;
}
