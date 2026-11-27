// The fanout payment: several shielded recipients, one transaction.
//
// It is short, because the wallet SDK does the hard part. `buildTransfer`
// (src/wallet/browser-wallet.ts) is one SDK call, `transferTransaction`, which:
//
//   1. picks which of the wallet's coins to spend (the inputs),
//   2. creates one new coin per recipient (the outputs),
//   3. creates a change coin back to the sender for whatever is left over,
//   4. adds the DUST fee,
//
// followed by signing and proving. Because all the outputs are in ONE
// transaction, the payout is atomic: either every recipient is paid or none is.
import type { FinalizedTransaction } from '@midnight-ntwrk/midnight-js-protocol/v9';
import type { TxRef } from './backend';

/** One recipient of the payout. */
export interface Payment {
  /** A shielded address, e.g. `mn_shield-addr_preprod1...`. */
  readonly recipient: string;
  /** The amount in the token's smallest unit (17.00 with 2 decimals is 1700n). */
  readonly amount: bigint;
}

/** The two wallet operations a fanout needs. */
export interface FanoutWallet {
  buildTransfer(tokenType: string, payments: readonly Payment[]): Promise<FinalizedTransaction>;
  submit(tx: FinalizedTransaction): Promise<string>;
}

/**
 * How many recipients go in one transaction. A list longer than this is paid
 * as several transactions, one after another.
 *
 * 64 is the largest payout that has been run with this code, not the network's
 * limit: 64 recipients make a transaction of about 343 KB (each recipient adds
 * a shielded output of about 5.1 KB, on top of about 8 KB for the sender's
 * input, the change and the fee), and a block holds about 1 MB. A worked
 * example on Preprod: transaction
 * 6e7a098a6e910b857408c7f865005bcb06d8a73eff613b746bc7a4eee2ef6518 (block 3,591,504).
 */
export const RECIPIENTS_PER_TRANSACTION = 64;

/**
 * How long one 64-recipient transaction takes from start to finalized: about
 * 24 seconds to select coins and prove (on a 24-thread machine), then about 20
 * for the network. Measured on Preprod over 2,000 recipients on 2026-11-26.
 */
export const SECONDS_PER_TRANSACTION = 45;

/** Cut a list into transactions of at most `size` recipients, keeping its order. */
export function inBatches<T>(items: readonly T[], size = RECIPIENTS_PER_TRANSACTION): T[][] {
  const batches: T[][] = [];
  for (let at = 0; at < items.length; at += size) batches.push(items.slice(at, at + size));
  return batches;
}

/** The sum the sender must hold, in the token's smallest unit. */
export const totalOf = (payments: readonly Payment[]): bigint =>
  payments.reduce((sum, payment) => sum + payment.amount, 0n);

/** The identifier, hash and size of a finished transaction. */
export function describeTx(tx: FinalizedTransaction): TxRef {
  const [txId] = tx.identifiers();
  if (!txId) throw new Error('The transaction has no identifier.');
  return { txId, txHash: tx.transactionHash(), bytes: tx.serialize().length };
}

/**
 * Pay every recipient in a single transaction.
 *
 * @param wallet    The wallet that pays.
 * @param tokenType The token to send: its 32-byte type ("color") as hex.
 * @param payments  Who gets how much. The same address may appear twice.
 * @param onBuilt   Called with the finished transaction just before it is
 *                  submitted, so the caller can store its hash first.
 */
export async function sendFanout(
  wallet: FanoutWallet,
  tokenType: string,
  payments: readonly Payment[],
  onBuilt?: (tx: TxRef) => void | Promise<void>,
): Promise<TxRef> {
  if (payments.length === 0) throw new Error('A payout needs at least one recipient.');

  // Step 1: ONE transfer with one output per recipient: coins selected, change
  // returned, fee added, everything proven and signed.
  const tx = await wallet.buildTransfer(tokenType, payments);
  const ref = describeTx(tx);
  await onBuilt?.(ref);

  // Step 2: hand the finished transaction to the network.
  await wallet.submit(tx);
  return ref;
}
