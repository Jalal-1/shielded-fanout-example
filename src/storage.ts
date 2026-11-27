// What this app remembers between page loads, in the browser's localStorage.
//
// It keeps the user's token deployment (with the secrets needed to mint again)
// and the progress of the payout list being paid: which line numbers went into
// which transaction. It never stores recipient addresses or amounts: those
// live in memory only, for as long as the page is open.
//
// Everything is stored per wallet account, so switching accounts in the wallet
// does not mix up tokens.
import type { TokenInfo, TokenMeta, TokenSecrets } from './backend';
import type { PayoutRecord } from './payout';
import { NETWORK_ID } from './network';

/**
 * The token contract this browser uses.
 *
 * `secrets` are present only when this browser deployed the contract, which
 * is what allows it to mint. A contract joined by address has none.
 * `info` is set only after the contract was read back from the chain.
 */
export interface StoredToken {
  readonly meta: TokenMeta;
  readonly secrets?: TokenSecrets;
  readonly info?: TokenInfo;
}

interface Stored {
  token?: StoredToken;
  payout?: PayoutRecord;
}

const key = (account: string): string => `shielded-fanout:v1:${NETWORK_ID}:${account}`;

function read(account: string): Stored {
  try {
    return JSON.parse(localStorage.getItem(key(account)) ?? '{}') as Stored;
  } catch {
    return {};
  }
}

function write(account: string, change: Partial<Stored>): void {
  localStorage.setItem(key(account), JSON.stringify({ ...read(account), ...change }));
}

export const loadToken = (account: string): StoredToken | undefined => read(account).token;
export const saveToken = (account: string, token: StoredToken | undefined): void => write(account, { token });
/** The payout list in progress: line numbers, hashes and times (see src/payout.ts). */
export const loadPayoutRecord = (account: string): PayoutRecord | undefined => {
  const record = read(account).payout;
  // Anything saved by an earlier version of this page has another shape: ignore it.
  return record && Array.isArray(record.transactions) && typeof record.fingerprint === 'string' ? record : undefined;
};
export const savePayoutRecord = (account: string, payout: PayoutRecord | undefined): void => write(account, { payout });

/** 32 fresh random bytes as hex. */
export function randomHex32(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}
