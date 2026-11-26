// What the UI needs from "the chain", apart from the wallet itself.
//
// There are two implementations:
//   - src/midnight/real-backend.ts talks to Midnight Preprod with Midnight.js.
//   - src/mock/mock-backend.ts fakes it in memory, for `pnpm dev:mock` and tests.
// The UI only knows this interface, so it runs the same way against both.
import type { Session } from './wallet';

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

/** The two names a transaction goes by. */
export interface TxRef {
  /** The identifier the indexer is asked about. */
  readonly txId: string;
  /** The hash block explorers and wallets show. */
  readonly txHash: string;
}

/** `pending` means the indexer has not seen the transaction (yet). */
export type TxOutcome = 'finalized' | 'failed' | 'pending';

export interface Backend {
  /** Deploy a new token contract owned by the connected wallet. */
  deployToken(session: Session, meta: TokenMeta, secrets: TokenSecrets): Promise<TokenInfo>;
  /** Mint `amount` (smallest unit) to the connected wallet. Resolves once finalized. */
  mint(session: Session, token: TokenInfo, secrets: TokenSecrets, amount: bigint): Promise<TxRef>;
  /** Read the id and hash out of a serialized transaction. */
  describeTx(tx: string): TxRef;
  /** Ask the indexer about a transaction, waiting up to `maxWaitMs` for it. */
  checkTx(session: Session, txId: string, maxWaitMs: number): Promise<TxOutcome>;
}
