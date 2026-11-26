// The fanout payment: several shielded recipients, one transaction.
//
// This is the whole trick, and it is small, because the wallet does the hard
// part. A DApp never sees the user's coins. It only tells the wallet what it
// wants to happen ("pay these people these amounts"), and the wallet:
//
//   1. picks which of the user's coins to spend (the inputs),
//   2. creates one new coin per recipient (the outputs),
//   3. creates a change coin back to the user for whatever is left over,
//   4. adds the tDUST fee,
//   5. proves and signs the transaction.
//
// Because all the outputs are in ONE transaction, the payout is atomic:
// either every recipient is paid or none is.
//
// Nothing in this file imports UI code or a Midnight library. It only needs
// two methods of the wallet's DApp Connector API (version 4.x):
// https://github.com/midnightntwrk/midnight-dapp-connector-api/blob/main/SPECIFICATION.md
import type { ConnectedAPI } from '@midnight-ntwrk/dapp-connector-api';

/** One recipient of the payout. */
export interface Payment {
  /** A shielded address, e.g. `mn_shield-addr_preprod1...`. */
  readonly recipient: string;
  /** The amount in the token's smallest unit (17.00 with 2 decimals is 1700n). */
  readonly amount: bigint;
}

/** The two wallet methods a fanout needs. Any connector 4.x wallet has them. */
export type FanoutWallet = Pick<ConnectedAPI, 'makeTransfer' | 'submitTransaction'>;

/**
 * The largest recipient count that has been sent in one transaction on Preprod
 * with this code. A transaction has a size limit, so a long enough list will
 * not fit. Raise this number only after a real payout of that size finalized.
 * `null` means no Preprod payout has been recorded yet.
 */
export const LARGEST_VERIFIED_RECIPIENT_COUNT: number | null = null;

/** The sum the sender must hold, in the token's smallest unit. */
export const totalOf = (payments: readonly Payment[]): bigint =>
  payments.reduce((sum, payment) => sum + payment.amount, 0n);

/**
 * Pay every recipient in a single transaction.
 *
 * @param wallet    The connected wallet.
 * @param tokenType The token to send: its 32-byte type ("color") as hex.
 * @param payments  Who gets how much. The same address may appear twice.
 * @param onBuilt   Called with the finished transaction just before it is
 *                  submitted, so the caller can store its hash first. If the
 *                  page dies during submission, the hash is not lost.
 * @returns The serialized transaction that was submitted.
 */
export async function sendFanout(
  wallet: FanoutWallet,
  tokenType: string,
  payments: readonly Payment[],
  onBuilt?: (tx: string) => void | Promise<void>,
): Promise<string> {
  if (payments.length === 0) throw new Error('A payout needs at least one recipient.');

  // Step 1: ask the wallet for ONE transfer with one output per recipient.
  // The user approves it in the wallet. The wallet selects inputs, returns the
  // change, pays the fee and proves, which can take a while.
  const { tx } = await wallet.makeTransfer(
    payments.map((payment) => ({
      kind: 'shielded' as const,
      type: tokenType,
      value: payment.amount,
      recipient: payment.recipient,
    })),
  );

  await onBuilt?.(tx);

  // Step 2: hand the finished transaction back to the wallet to broadcast.
  await wallet.submitTransaction(tx);
  return tx;
}
