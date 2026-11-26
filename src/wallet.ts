// Finding and talking to the user's wallet.
//
// A Midnight wallet extension adds itself to `window.midnight` under a random
// key. Each entry is an "initial API": a name, an icon, the connector version
// it speaks, and `connect()`. Connecting returns the "connected API", which is
// everything else: balances, addresses, transfers.
import type { ConnectedAPI, InitialAPI } from '@midnight-ntwrk/dapp-connector-api';
import semver from 'semver';

/** The only network this app works on. */
export const NETWORK_ID = 'preprod';

/** The connector versions this app was written against. */
export const SUPPORTED_CONNECTOR = '4.x';

export const FAUCET_URL = 'https://midnight-tmnight-preprod.nethermind.dev/';

/** tNIGHT's token type: 32 zero bytes. Unshielded balances are keyed by it. */
const NIGHT_TOKEN_TYPE = '00'.repeat(32);
export const NIGHT_DECIMALS = 6;
export const DUST_DECIMALS = 15;

declare global {
  interface Window {
    midnight?: Record<string, InitialAPI>;
  }
}

/** A wallet the user connected, plus what we learned about it on the way in. */
export interface Session {
  readonly api: ConnectedAPI;
  readonly walletName: string;
  /** The user's shielded address (Bech32m). Coins minted here land on it. */
  readonly shieldedAddress: string;
  /** The key that owns the user's coins, as the wallet reports it (Bech32m). */
  readonly shieldedCoinPublicKey: string;
}

/** Every installed wallet that speaks a connector version we support. */
export function listWallets(): InitialAPI[] {
  const installed = Object.values(window.midnight ?? {});
  return installed.filter(
    (wallet) =>
      typeof wallet?.connect === 'function' &&
      semver.valid(wallet.apiVersion) !== null &&
      semver.satisfies(wallet.apiVersion, SUPPORTED_CONNECTOR),
  );
}

/** Ask the wallet to connect on Preprod. The user approves this in the wallet. */
export async function connectWallet(wallet: InitialAPI): Promise<Session> {
  const api = await wallet.connect(NETWORK_ID);

  // `connect(networkId)` is only a hint, so confirm where the wallet really is.
  const { networkId } = await api.getConfiguration();
  if (networkId !== NETWORK_ID) {
    throw new Error(`The wallet is on "${networkId}". Switch it to Preprod and connect again.`);
  }

  const { shieldedAddress, shieldedCoinPublicKey } = await api.getShieldedAddresses();
  return { api, walletName: wallet.name, shieldedAddress, shieldedCoinPublicKey };
}

/** What the user needs before any transaction: tNIGHT, and tDUST generated from it. */
export interface Funds {
  /** Unshielded tNIGHT, in its smallest unit. */
  readonly night: bigint;
  /** tDUST, in its smallest unit. Fees are paid in it. */
  readonly dust: bigint;
}

export async function readFunds(api: ConnectedAPI): Promise<Funds> {
  const [unshielded, dust] = await Promise.all([api.getUnshieldedBalances(), api.getDustBalance()]);
  return { night: balanceOf(unshielded, NIGHT_TOKEN_TYPE), dust: dustValue(dust) };
}

/** The spendable balance of one shielded token. */
export async function readTokenBalance(api: ConnectedAPI, tokenType: string): Promise<bigint> {
  return balanceOf(await api.getShieldedBalances(), tokenType);
}

/** Balances are keyed by token type as hex. Compare without regard to case. */
function balanceOf(balances: Record<string, bigint>, tokenType: string): bigint {
  const wanted = tokenType.toLowerCase();
  for (const [type, value] of Object.entries(balances)) {
    if (type.toLowerCase() === wanted) return BigInt(value);
  }
  return 0n;
}

/** `getDustBalance` reports the spendable balance, alone or beside its cap. */
function dustValue(dust: unknown): bigint {
  if (typeof dust === 'bigint') return dust;
  if (typeof dust === 'object' && dust !== null && 'balance' in dust) return BigInt(dust.balance as bigint);
  return 0n;
}

/**
 * Find the wallet's own error inside whatever was thrown. Midnight.js wraps a
 * failure from the wallet in its own error and keeps the original on `cause`.
 */
function connectorErrorIn(error: unknown): { code: string; reason: string } | null {
  for (let current = error, depth = 0; current && depth < 5; depth++) {
    if (typeof current === 'object' && 'code' in current && String(current.code) in SENTENCES) {
      const reason = 'reason' in current && typeof current.reason === 'string' ? current.reason : '';
      return { code: String(current.code), reason: reason || (current instanceof Error ? current.message : '') };
    }
    current = typeof current === 'object' && 'cause' in current ? current.cause : null;
  }
  return null;
}

/** One sentence per connector error code; see "Errors" in the connector specification. */
const SENTENCES: Record<string, (reason: string) => string> = {
  Rejected: () => 'You declined the request in your wallet. Nothing was sent.',
  InsufficientFunds: () =>
    'Your wallet does not have enough to cover this: either not enough of the token, or not enough tDUST for the fee.',
  PermissionRejected: () =>
    'Your wallet does not allow this site to do that. Check the site permissions in your wallet.',
  Disconnected: () => 'The connection to your wallet was lost. Reload the page and connect again.',
  InvalidRequest: (reason) => `Your wallet did not accept the request: ${reason}`,
  InternalError: (reason) => `Your wallet could not complete the request: ${reason}`,
};

/** Turn anything a wallet or chain call can throw into one plain sentence. */
export function explainError(error: unknown): string {
  const fromWallet = connectorErrorIn(error);
  if (fromWallet) return SENTENCES[fromWallet.code]!(fromWallet.reason);
  return error instanceof Error ? error.message : String(error);
}
