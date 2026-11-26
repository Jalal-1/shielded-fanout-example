// What this app remembers between page loads, in the browser's localStorage.
//
// It keeps the user's token deployment (with the secrets needed to mint again)
// and the hash of the last payout. It never stores recipient addresses or
// amounts: those live in memory only, for as long as the page is open.
//
// Everything is stored per wallet account, so switching accounts in the wallet
// does not mix up tokens.
import type { TokenInfo, TokenMeta, TokenSecrets, TxRef } from './backend';
import { NETWORK_ID } from './wallet';

/** A token the user started deploying. `info` is set once the deploy finalized. */
export interface StoredToken {
  readonly meta: TokenMeta;
  readonly secrets: TokenSecrets;
  readonly info?: TokenInfo;
}

/** The last payout this browser sent, without its recipients or amounts. */
export interface StoredPayout extends TxRef {
  /** `built`: the wallet returned it. `submitted`: handed to the network. */
  readonly status: 'built' | 'submitted' | 'finalized' | 'failed';
  readonly at: string;
}

interface Stored {
  token?: StoredToken;
  payout?: StoredPayout;
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
export const loadPayout = (account: string): StoredPayout | undefined => read(account).payout;
export const savePayout = (account: string, payout: StoredPayout | undefined): void => write(account, { payout });

/** 32 fresh random bytes as hex. */
export function randomHex32(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}
