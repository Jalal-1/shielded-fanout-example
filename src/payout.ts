// Keeping track of a payout list: which line was paid, which was not, and
// which can safely be sent again.
//
// A list is paid as one or more transactions (src/fanout.ts). The unit that
// succeeds or fails is the transaction, so the record below is a list of
// transactions and the line numbers each one carried. Everything shown about a
// single line is worked out from that.
//
// The record holds line numbers, hashes and times: no addresses, no amounts.
// That lets it be stored in the browser, and a reloaded page can pick the
// payout up again once the same list is loaded (see `fingerprintOf`).
import type { Payment } from './fanout';

/** What became of one transaction. */
export type TxOutcome =
  /** Being built, or built and waiting for the network. */
  | 'sending'
  /** Finalized on chain: every line in it was paid. */
  | 'paid'
  /** Never built, or failed on chain: no line in it was paid. Safe to send again. */
  | 'failed'
  /** Built and handed over, but the network has not reported it. NOT safe to send again yet. */
  | 'unconfirmed';

/** One transaction of a payout. */
export interface PayoutTx {
  /** The lines of the list it carries, numbered from 1. */
  readonly lines: readonly number[];
  /** When building it started. */
  readonly at: string;
  /** Set once the wallet has built it, which is before it is submitted. */
  readonly txId?: string;
  readonly txHash?: string;
  readonly bytes?: number;
  /** Selecting coins, proving and signing, in milliseconds. */
  readonly buildMs?: number;
  /** From built to the network's verdict. */
  readonly finalizeMs?: number;
  readonly outcome: TxOutcome;
  /** Why it failed or is unconfirmed, in a sentence. */
  readonly note?: string;
}

/** One press of the pay button: when it started, when and why it ended. */
export interface PayoutRun {
  readonly startedAt: string;
  readonly wallets: number;
  readonly transactions: number;
  readonly endedAt?: string;
  /** Why it stopped before the end of the list, when it did. */
  readonly stopped?: string;
}

/** Everything remembered about one payout list. */
export interface PayoutRecord {
  /** Identifies the list without containing it. */
  readonly fingerprint: string;
  readonly lineCount: number;
  readonly transactions: readonly PayoutTx[];
  /** The latest run. */
  readonly run?: PayoutRun;
}

/** What to show for one line. */
export type LineStatus = 'paid' | 'failed' | 'unconfirmed' | 'sending' | 'waiting' | 'not sent';

export interface LineState {
  readonly status: LineStatus;
  /** The latest transaction that carried this line, if any. */
  readonly tx?: PayoutTx;
}

/**
 * A transaction is valid for 30 minutes (the wallet's TTL). One that the
 * network still has not reported some minutes after that can no longer be
 * included, so its lines were not paid.
 */
export const UNCONFIRMED_EXPIRES_MS = 35 * 60_000;

/**
 * The state of every line, in list order.
 *
 * A line that was in several transactions (failed, then sent again) is judged
 * by the latest. While a run is in progress, lines it has not reached yet are
 * `waiting`; otherwise they are `not sent`.
 */
export function lineStates(record: PayoutRecord, running: boolean): LineState[] {
  const latest = new Array<PayoutTx | undefined>(record.lineCount).fill(undefined);
  for (const tx of record.transactions) for (const line of tx.lines) latest[line - 1] = tx;
  const runStart = record.run?.startedAt ?? '';
  return latest.map((tx) => {
    if (!tx) return { status: running ? 'waiting' : 'not sent' };
    // A failure from an earlier run is on this run's to-do list again.
    if (tx.outcome === 'failed' && running && tx.at < runStart) return { status: 'waiting', tx };
    return { status: tx.outcome, tx };
  });
}

/** How many lines are in each state. */
export function countStates(states: readonly LineState[]): Record<LineStatus, number> {
  const counts: Record<LineStatus, number> = { paid: 0, failed: 0, unconfirmed: 0, sending: 0, waiting: 0, 'not sent': 0 };
  for (const state of states) counts[state.status]++;
  return counts;
}

/**
 * The lines that are safe to send (again): never sent, or in a transaction
 * that failed. Never a line that was paid, and never one whose transaction
 * may still arrive.
 */
export function unpaidLines(record: PayoutRecord): number[] {
  return lineStates(record, false).flatMap((state, index) =>
    state.status === 'not sent' || state.status === 'failed' ? [index + 1] : [],
  );
}

/** A copy of the record with its transaction at `index` replaced. */
export function withTx(record: PayoutRecord, index: number, tx: PayoutTx): PayoutRecord {
  const transactions = [...record.transactions];
  transactions[index] = tx;
  return { ...record, transactions };
}

/**
 * Tidy a record that was read back after a reload. A transaction the page was
 * still working on has no verdict: if it had been built it may have been
 * submitted, so it is unconfirmed; if not, nothing was sent.
 */
export function afterReload(record: PayoutRecord): PayoutRecord {
  const transactions = record.transactions.map((tx): PayoutTx => {
    if (tx.outcome !== 'sending') return tx;
    return tx.txId
      ? { ...tx, outcome: 'unconfirmed', note: 'The page was reloaded before the network reported this transaction.' }
      : { ...tx, outcome: 'failed', note: 'The page was reloaded before this transaction was built. Nothing was sent.' };
  });
  const run =
    record.run && !record.run.endedAt && !record.run.stopped
      ? { ...record.run, stopped: 'The page was reloaded before the run finished.' }
      : record.run;
  return { ...record, transactions, run };
}

/**
 * A short name for a list, so a stored record can be matched to the same list
 * when it is loaded again. It is a SHA-256 of the addresses and amounts in
 * order; the list cannot be recovered from it.
 */
export async function fingerprintOf(payments: readonly Payment[]): Promise<string> {
  const text = payments.map((payment) => `${payment.recipient} ${payment.amount}`).join('\n');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest).slice(0, 16), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** 1,2,3,7,8 becomes "1-3, 7-8": a short way to name many lines. */
export function lineRanges(lines: readonly number[]): string {
  const runs: Array<[number, number]> = [];
  for (const line of lines) {
    const last = runs.at(-1);
    if (last && last[1] === line - 1) last[1] = line;
    else runs.push([line, line]);
  }
  return runs.map(([from, to]) => (from === to ? `${from}` : `${from}-${to}`)).join(', ');
}

/**
 * The whole list with what became of each line, as CSV text: line, address,
 * amount, status, transaction hash, note. When the recipients were checked on
 * chain, `received` adds what each line's wallet was found to have received.
 */
export function resultsCsv(
  payments: readonly Payment[],
  states: readonly LineState[],
  showAmount: (amount: bigint) => string,
  received?: (line: number) => bigint | undefined,
): string {
  const cell = (text: string) => (/[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text);
  const rows = payments.map((payment, index) => {
    const state = states[index];
    return [
      String(index + 1),
      payment.recipient,
      showAmount(payment.amount),
      state?.status ?? 'not sent',
      state?.tx?.txHash ?? '',
      state?.tx?.note ?? '',
      ...(received ? [((amount) => (amount === undefined ? '' : showAmount(amount)))(received(index + 1))] : []),
    ]
      .map(cell)
      .join(',');
  });
  const header = `line,address,amount,status,transaction,note${received ? ',received on chain' : ''}`;
  return [header, ...rows].join('\n') + '\n';
}
