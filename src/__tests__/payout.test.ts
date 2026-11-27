import { describe, expect, it } from 'vitest';
import {
  afterReload,
  countStates,
  fingerprintOf,
  lineRanges,
  lineStates,
  listMismatch,
  resultsCsv,
  unpaidLines,
  withTx,
  type PayoutRecord,
  type PayoutTx,
} from '../payout';

const lines = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, index) => from + index);
const tx = (from: number, to: number, outcome: PayoutTx['outcome'], at = '2026-01-01T00:00:00Z'): PayoutTx => ({
  lines: lines(from, to),
  at,
  outcome,
  ...(outcome === 'sending' ? {} : { txId: `id-${from}`, txHash: `hash-${from}` }),
});
const record = (transactions: PayoutTx[], lineCount = 10): PayoutRecord => ({ fingerprint: 'f', lineCount, transactions });

describe('which lines are safe to send', () => {
  it('sends everything on a fresh list', () => {
    expect(unpaidLines(record([]))).toEqual(lines(1, 10));
  });

  it('never sends a paid line again', () => {
    expect(unpaidLines(record([tx(1, 4, 'paid')]))).toEqual(lines(5, 10));
  });

  it('sends the lines of a failed transaction again', () => {
    expect(unpaidLines(record([tx(1, 4, 'paid'), tx(5, 8, 'failed')]))).toEqual(lines(5, 10));
  });

  it('holds back lines whose transaction may still arrive', () => {
    expect(unpaidLines(record([tx(1, 4, 'unconfirmed'), tx(5, 8, 'failed')]))).toEqual(lines(5, 10));
  });

  it('judges a line by the latest transaction that carried it', () => {
    const retried = record([tx(1, 4, 'failed'), tx(1, 4, 'paid', '2026-01-01T00:10:00Z')]);
    expect(unpaidLines(retried)).toEqual(lines(5, 10));
    expect(countStates(lineStates(retried, false))).toMatchObject({ paid: 4, failed: 0, 'not sent': 6 });
  });
});

describe('what each line shows', () => {
  it('counts every state', () => {
    const states = lineStates(record([tx(1, 3, 'paid'), tx(4, 5, 'failed'), tx(6, 7, 'unconfirmed')]), false);
    expect(countStates(states)).toEqual({ paid: 3, failed: 2, unconfirmed: 2, sending: 0, waiting: 0, 'not sent': 3 });
  });

  it('shows lines a run has not reached yet as waiting, including earlier failures', () => {
    const running: PayoutRecord = {
      ...record([tx(1, 2, 'failed', '2026-01-01T00:00:00Z'), tx(3, 4, 'sending', '2026-01-01T01:00:05Z')]),
      run: { startedAt: '2026-01-01T01:00:00Z', wallets: 10, transactions: 5 },
    };
    expect(lineStates(running, true).map((state) => state.status)).toEqual([
      'waiting', 'waiting', 'sending', 'sending', 'waiting', 'waiting', 'waiting', 'waiting', 'waiting', 'waiting',
    ]);
  });
});

describe('a record read back after a reload', () => {
  it('treats a built transaction as unconfirmed and an unbuilt one as not sent', () => {
    const built: PayoutTx = { ...tx(1, 2, 'sending'), txId: 'id', txHash: 'hash' };
    const reloaded = afterReload({
      ...record([built, tx(3, 4, 'sending')]),
      run: { startedAt: '2026-01-01T00:00:00Z', wallets: 10, transactions: 5 },
    });
    expect(reloaded.transactions.map((entry) => entry.outcome)).toEqual(['unconfirmed', 'failed']);
    expect(reloaded.run?.stopped).toMatch(/reloaded/);
    // The built one is held back; the unbuilt one and the rest can be sent.
    expect(unpaidLines(reloaded)).toEqual(lines(3, 10));
  });
});

describe('helpers', () => {
  it('replaces one transaction without touching the others', () => {
    const start = record([tx(1, 2, 'sending'), tx(3, 4, 'sending')]);
    const next = withTx(start, 1, tx(3, 4, 'paid'));
    expect(next.transactions.map((entry) => entry.outcome)).toEqual(['sending', 'paid']);
    expect(start.transactions[1]?.outcome).toBe('sending');
  });

  it('names many lines briefly', () => {
    expect(lineRanges([1, 2, 3, 7, 9, 10])).toBe('1-3, 7, 9-10');
  });

  it('gives the same list the same fingerprint, and another list another', async () => {
    const list = [{ recipient: 'a', amount: 1n }, { recipient: 'b', amount: 2n }];
    expect(await fingerprintOf(list)).toBe(await fingerprintOf([...list]));
    expect(await fingerprintOf(list)).not.toBe(await fingerprintOf([...list].reverse()));
  });

  it('writes every line to the results file', () => {
    const payments = [{ recipient: 'addr1', amount: 100n }, { recipient: 'addr2', amount: 250n }];
    const failed: PayoutTx = { ...tx(2, 2, 'failed'), note: 'It could not be built: a, "b"' };
    const states = lineStates(record([tx(1, 1, 'paid'), failed], 2), false);
    expect(resultsCsv(payments, states, (amount) => String(amount)).split('\n')).toEqual([
      'line,address,amount,status,transaction,note',
      '1,addr1,100,paid,hash-1,',
      '2,addr2,250,failed,hash-2,"It could not be built: a, ""b"""',
      '',
    ]);
  });
});

describe('continuing a payout with its list loaded again', () => {
  const inProgress: PayoutRecord = { fingerprint: 'abc', lineCount: 500, transactions: [tx(1, 64, 'paid')] };

  it('accepts the list the record belongs to', () => {
    expect(listMismatch(inProgress, 500, 'abc')).toBeNull();
  });

  it('refuses a list of another length, and says both lengths', () => {
    expect(listMismatch(inProgress, 64, 'abc')).toMatch(/64 lines.*list of 500/);
  });

  it('refuses a list of the same length whose content differs', () => {
    expect(listMismatch(inProgress, 500, 'abd')).toMatch(/an address, an amount or the order differs/);
  });
});
