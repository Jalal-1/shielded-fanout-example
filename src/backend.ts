// What the UI needs from the token contract.
//
// The one implementation is src/midnight/real-backend.ts, which talks to
// Midnight with Midnight.js and the in-page wallet. The UI only knows
// this interface, which keeps it free of Midnight.js details.
import type { BrowserWallet } from './wallet/browser-wallet';

/** The user's chosen token metadata. It is fixed when the contract is deployed. */
export interface TokenMeta {
  readonly name: string;
  readonly symbol: string;
  readonly decimals: number;
}

/** A deployed token. */
export interface TokenInfo extends TokenMeta {
  readonly contractAddress: string;
  /** The token's 32-byte type ("color") as hex. Wallet balances are keyed by it. */
  readonly tokenType: string;
}

/** The secrets behind a deployment. Whoever holds them (and the owner's key) can mint. */
export interface TokenSecrets {
  /** Proves ownership when minting. 32 bytes as hex. */
  readonly secretNonce: string;
  /** Makes this deployment's owner commitment unique. 32 bytes as hex. */
  readonly instanceSalt: string;
}

/** The two names a transaction goes by, and its size. */
export interface TxRef {
  /** The identifier the indexer is asked about. */
  readonly txId: string;
  /** The hash block explorers show. */
  readonly txHash: string;
  /** Size of the finished transaction in bytes. */
  readonly bytes?: number;
}

/** `pending` means the indexer has not seen the transaction (yet). */
export type TxOutcome = 'finalized' | 'failed' | 'pending';

/** Where a contract transaction is. */
export type Stage = 'preparing' | 'proving' | 'signing' | 'submitting' | 'finalizing';

export interface Backend {
  /** Deploy a new token contract owned by the wallet. Resolves once it is on chain. */
  deployToken(
    wallet: BrowserWallet,
    meta: TokenMeta,
    secrets: TokenSecrets,
    onStage?: (stage: Stage) => void,
  ): Promise<TokenInfo>;
  /** Mint `amount` (smallest unit) to the wallet. Resolves once finalized. */
  mint(
    wallet: BrowserWallet,
    token: TokenInfo,
    secrets: TokenSecrets,
    amount: bigint,
    onStage?: (stage: Stage) => void,
  ): Promise<TxRef>;
  /**
   * Read a token contract from the chain. Returns `null` when no contract
   * exists at that address, so nothing is ever shown as deployed on trust.
   */
  readToken(wallet: BrowserWallet, contractAddress: string): Promise<TokenInfo | null>;
  /** Ask the indexer about a transaction, waiting up to `maxWaitMs` for it. */
  checkTx(wallet: BrowserWallet, txId: string, maxWaitMs: number): Promise<TxOutcome>;
  /** A transaction's bytes as hex, by its hash, or `null` when the indexer has none. */
  txRaw(txHash: string): Promise<string | null>;
  /**
   * True when the indexer answers that it has no transaction with this
   * identifier. Throws when the indexer cannot be asked, so that "not there"
   * is never assumed.
   */
  txIsAbsent(txId: string): Promise<boolean>;
}
