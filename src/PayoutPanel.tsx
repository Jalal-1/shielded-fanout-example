// The payout screen: load a list, pay it, and see what became of every line.
//
//   PayoutInput   the list as text or from a file, checked line by line
//   TestWallets   makes a batch of wallets to pay, when you have nobody to pay
//   PayoutBoard   one row per line with its state, the transactions behind
//                 them, and the buttons to send what is still unpaid
//
// src/PayoutResume.tsx is the way back to a payout whose list is no longer on
// screen.
// The sending itself is in src/App.tsx (`payList`), on top of src/fanout.ts.
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { shieldedAddressPrefix } from './address';
import { formatAmount, parseAmount } from './amounts';
import type { TokenInfo } from './backend';
import { RECIPIENTS_PER_TRANSACTION, SECONDS_PER_TRANSACTION, totalOf, type Payment } from './fanout';
import { parseList } from './list';
import { NETWORK_ID } from './network';
import {
  countStates,
  fingerprintOf,
  lineRanges,
  lineStates,
  resultsCsv,
  unpaidLines,
  type LineStatus,
  type PayoutRecord,
} from './payout';
import {
  deriveRecipients,
  forgetTestRecipients,
  loadTestRecipients,
  receivedFrom,
  saveTestRecipients,
  type TestRecipients,
} from './recipients';
import { BalanceLine, Elapsed, duration } from './widgets';

const STATUS_LABEL: Record<LineStatus, string> = {
  paid: 'Paid',
  failed: 'Failed, not paid',
  unconfirmed: 'Unconfirmed',
  sending: 'Sending…',
  waiting: 'Waiting',
  'not sent': 'Not sent',
};

/** "a list of 3 things" needs its noun to agree. */
export const wallets = (count: number): string => `${count.toLocaleString('en')} ${count === 1 ? 'wallet' : 'wallets'}`;

// ── The list ─────────────────────────────────────────────────────────────────

export function PayoutInput(props: {
  token: TokenInfo;
  balance: bigint;
  arriving: bigint;
  disabled: boolean;
  /** A payout already in progress in this browser, if any. */
  record: PayoutRecord | undefined;
  /** Pay `payments`. `resume` is true when they are the list `record` belongs to. */
  onStart: (payments: Payment[], fingerprint: string, resume: boolean) => void;
  /** Back to the payout in progress, leaving this form. */
  onBack: () => void;
}) {
  const { token, record, balance } = props;

  // The recipients live here, in memory, and nowhere else.
  const [list, setList] = useState('');

  // One recipient per line: "address amount". One line pays one wallet, many lines pay many.
  // Checked once per edit, not on every refresh of the page: a list can be thousands of lines.
  const { count, firstProblem, payments } = useMemo(
    () => parseList(list, token.decimals, NETWORK_ID),
    [list, token.decimals],
  );
  const ready = count > 0 && !firstProblem;

  // Is this the list a payout is already in progress for?
  const [fingerprint, setFingerprint] = useState<string | null>(null);
  useEffect(() => {
    let current = true;
    setFingerprint(null);
    if (payments.length > 0) void fingerprintOf(payments).then((value) => current && setFingerprint(value));
    return () => {
      current = false;
    };
  }, [payments]);
  const resume = !!record && fingerprint === record.fingerprint && count === record.lineCount;

  // What a press of the button would send: the whole list, or what is left of the one in progress.
  const toSend = useMemo(
    () => (resume && record ? unpaidLines(record).map((line) => payments[line - 1]!) : payments),
    [resume, record, payments],
  );
  const recordCounts = useMemo(() => (record ? countStates(lineStates(record, false)) : null), [record]);
  const total = totalOf(toSend);
  const overBalance = ready && total > balance;
  const transactions = Math.ceil(toSend.length / RECIPIENTS_PER_TRANSACTION);
  const minutes = Math.max(1, Math.round((transactions * SECONDS_PER_TRANSACTION) / 60));
  // When the balance is too small for the whole list: how many lines from the top it does cover.
  let affordable = 0;
  for (let sum = 0n; affordable < toSend.length && sum + toSend[affordable]!.amount <= balance; affordable++)
    sum += toSend[affordable]!.amount;
  const show = (amount: bigint) => `${formatAmount(amount, token.decimals)} ${token.symbol}`;
  const canStart = ready && fingerprint !== null && !overBalance && !props.disabled;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (canStart && fingerprint) props.onStart(payments, fingerprint, resume);
  };

  /** A long list is easier to load from a file than to paste. */
  const loadFile = async (file: File | undefined) => {
    if (file) setList(await file.text());
  };

  return (
    <form className="payout-input" onSubmit={submit}>
      {record && recordCounts && (
        <div className="notice" data-testid="payout-in-progress">
          <p>
            <strong>Another payout is in progress in this browser:</strong>{' '}
            {recordCounts.paid.toLocaleString('en')} of {wallets(record.lineCount)} paid
            {recordCounts.unconfirmed > 0 && `, ${recordCounts.unconfirmed.toLocaleString('en')} unconfirmed`}.{' '}
            Paying a different list here replaces its record.
          </p>
          <button type="button" className="secondary" onClick={props.onBack}>
            Back to the payout in progress
          </button>
        </div>
      )}

      <BalanceLine token={token} balance={balance} arriving={props.arriving} />

      <TestWallets token={token} disabled={props.disabled} onList={setList} />

      <label className="grow">
        Who to pay: one wallet per line, its shielded address and then the amount
        <textarea
          className="mono"
          value={list}
          spellCheck={false}
          placeholder={`${shieldedAddressPrefix(NETWORK_ID)}1…  17\n${shieldedAddressPrefix(NETWORK_ID)}1…  29`}
          onChange={(event) => setList(event.target.value)}
        />
      </label>
      <label className="hint">
        Or load the list from a text file, in the same format:{' '}
        <input
          type="file"
          accept=".txt,.csv,text/plain"
          data-testid="payout-file"
          onChange={(event) => {
            void loadFile(event.target.files?.[0]);
            event.target.value = '';
          }}
        />
      </label>

      <p className={firstProblem || overBalance ? 'field-error' : 'hint'} data-testid="payout-summary">
        {count === 0
          ? `One line pays one wallet. Up to ${RECIPIENTS_PER_TRANSACTION} lines go in a single transaction; a longer list is sent as several, one after another.`
          : firstProblem
            ? `Line ${firstProblem.index + 1}: ${firstProblem.problem}`
            : resume && toSend.length === 0
              ? `This is the list in progress, and all ${wallets(count)} on it are paid or awaiting confirmation.`
              : overBalance
                ? `That is ${show(total)} in total, more than the ${show(balance)} you can spend. Your balance covers the first ${affordable} lines.`
                : resume
                  ? `This is the list in progress: ${wallets(count - toSend.length)} already paid, ${wallets(toSend.length)} still to pay (${show(total)}).`
                  : `${wallets(count)}, ${show(total)} in total. ${show(balance - total)} stays in your wallet.`}
      </p>
      {ready && !overBalance && transactions > 1 && (
        <p className="hint">
          That is {transactions} transactions of up to {RECIPIENTS_PER_TRANSACTION} wallets, sent one after another: about{' '}
          {minutes} {minutes === 1 ? 'minute' : 'minutes'} at {SECONDS_PER_TRANSACTION} seconds each. Keep this tab open
          and in front until it is done.
        </p>
      )}
      {ready && !resume && record && recordCounts && recordCounts.paid + recordCounts.unconfirmed > 0 && (
        <p className="hint">This is a different list from the one in progress. Paying it replaces that record.</p>
      )}

      <div className="row-actions">
        <button type="submit" disabled={!canStart}>
          {resume
            ? toSend.length === 0
              ? 'Show this list'
              : `Send the ${wallets(toSend.length)} still unpaid`
            : count <= 1
              ? 'Send the payment'
              : transactions === 1
                ? `Pay ${count} wallets in one transaction`
                : `Pay ${count.toLocaleString('en')} wallets in ${transactions} transactions`}
        </button>
      </div>
      <p className="hint">
        Addresses and amounts stay in this page's memory. Only line numbers and transaction hashes are stored, so a
        reloaded page can continue the same list.
      </p>
    </form>
  );
}

// ── Somebody to pay ──────────────────────────────────────────────────────────

/** The largest batch offered: enough to try a long payout, small enough to make in a few seconds. */
const MOST_TEST_WALLETS = 5000;

/**
 * Makes a batch of test wallets and puts them in the list.
 *
 * All of them come from one recovery phrase kept in this browser (see
 * src/recipients.ts). Wallet 1 is always the same wallet, so a larger batch
 * contains the smaller one, and the board can later check on chain what each
 * of them received.
 */
function TestWallets(props: { token: TokenInfo; disabled: boolean; onList: (list: string) => void }) {
  const { token } = props;
  const [saved, setSaved] = useState<TestRecipients | null>(loadTestRecipients);
  const [countText, setCountText] = useState('64');
  const [amountText, setAmountText] = useState('1');
  const [working, setWorking] = useState<string | null>(null);
  const [phraseShown, setPhraseShown] = useState(false);

  const count = Number(countText);
  const countOk = /^\d+$/.test(countText.trim()) && count >= 1 && count <= MOST_TEST_WALLETS;
  const amount = parseAmount(amountText, token.decimals);

  const make = async () => {
    if (!countOk || !amount.ok) return;
    const next = saveTestRecipients(count, saved);
    setSaved(next);
    setWorking('Making the wallets…');
    try {
      const recipients = await deriveRecipients(next.mnemonic, count, (done) =>
        setWorking(`Making the wallets: ${done.toLocaleString('en')} of ${count.toLocaleString('en')}…`),
      );
      props.onList(recipients.map((recipient) => `${recipient.address} ${amountText.trim()}`).join('\n'));
    } finally {
      setWorking(null);
    }
  };

  const startOver = () => {
    if (!window.confirm('Forget this recovery phrase? The test wallets made from it can then no longer be checked or opened.')) return;
    forgetTestRecipients();
    setSaved(null);
    setPhraseShown(false);
  };

  const terminalCommand = `node scripts/check-recipients.mjs --mnemonic-file phrase.txt --count ${saved?.count ?? count} --network ${NETWORK_ID} --decimals ${token.decimals}`;

  return (
    <details className="test-wallets" data-testid="test-wallets">
      <summary>Nobody to pay yet? Make a batch of test wallets</summary>
      <div className="fields">
        <label>
          How many wallets
          <input
            inputMode="numeric"
            value={countText}
            data-testid="test-wallet-count"
            onChange={(event) => setCountText(event.target.value)}
          />
        </label>
        <label>
          Amount for each, in {token.symbol}
          <input inputMode="decimal" value={amountText} onChange={(event) => setAmountText(event.target.value)} />
        </label>
      </div>
      {!countOk && <p className="field-error">Enter a number from 1 to {MOST_TEST_WALLETS.toLocaleString('en')}.</p>}
      {!amount.ok && <p className="field-error">{amount.error}</p>}
      <div className="row-actions">
        <button
          type="button"
          className="secondary"
          disabled={props.disabled || working !== null || !countOk || !amount.ok}
          onClick={() => void make()}
        >
          {working ?? `Make ${countOk ? count.toLocaleString('en') : ''} test wallets and fill the list`}
        </button>
      </div>
      {saved && (
        <>
          <p className="hint">
            The test wallets all come from one recovery phrase, kept in this browser. After you pay them, the page can
            check on chain what each one received. Save the phrase if you want to open the wallets anywhere else: on
            a wallet app it opens wallet 1.
          </p>
          {phraseShown && <p className="mono command">{saved.mnemonic}</p>}
          <div className="row-actions">
            <button type="button" className="secondary" onClick={() => setPhraseShown(!phraseShown)}>
              {phraseShown ? 'Hide the phrase' : 'Show the phrase'}
            </button>
            <button type="button" className="secondary" onClick={() => void navigator.clipboard?.writeText(saved.mnemonic)}>
              Copy the phrase
            </button>
            <button type="button" className="secondary" disabled={props.disabled} onClick={startOver}>
              Start over with a new phrase
            </button>
          </div>
          <p className="hint">
            The same check from a terminal, in a clone of the repository, with the phrase saved as{' '}
            <code>phrase.txt</code>:
          </p>
          <p className="mono command">{terminalCommand}</p>
        </>
      )}
    </details>
  );
}

// ── What became of every line ────────────────────────────────────────────────

type Filter = 'all' | 'paid' | 'problem' | 'unconfirmed' | 'todo';

/** What the chain check found for one line: what its wallet received from the line's transaction, and whether that is what was sent. */
interface Receipt {
  readonly amount: bigint;
  readonly ok: boolean;
}

const FILTERS: ReadonlyArray<{ key: Filter; label: string; matches: (status: LineStatus) => boolean }> = [
  { key: 'all', label: 'All', matches: () => true },
  { key: 'paid', label: 'Paid', matches: (status) => status === 'paid' },
  { key: 'problem', label: 'Failed', matches: (status) => status === 'failed' },
  { key: 'unconfirmed', label: 'Unconfirmed', matches: (status) => status === 'unconfirmed' },
  { key: 'todo', label: 'Not sent yet', matches: (status) => status === 'not sent' || status === 'waiting' || status === 'sending' },
];

export function PayoutBoard(props: {
  token: TokenInfo;
  payments: readonly Payment[];
  record: PayoutRecord;
  running: boolean;
  stopping: boolean;
  /** True while the page is busy with anything, including this payout. */
  busy: boolean;
  balance: bigint;
  onStop: () => void;
  onSendUnpaid: () => void;
  onCheck: () => void;
  onNew: () => void;
  /** A transaction's bytes as hex, by its hash: what the chain check reads. */
  fetchTx: (txHash: string) => Promise<string | null>;
}) {
  const { token, payments, record, running } = props;
  const [filter, setFilter] = useState<Filter>('all');
  // The chain check of the test wallets: what each line's wallet received, once looked at.
  const [received, setReceived] = useState<ReadonlyMap<number, Receipt>>(new Map());
  const [checking, setChecking] = useState<string | null>(null);
  const [checkError, setCheckError] = useState<string | null>(null);
  const stopChecking = useRef(false);
  const [hasTestWallets] = useState(() => loadTestRecipients() !== null);

  const states = useMemo(() => lineStates(record, running), [record, running]);
  const counts = useMemo(() => countStates(states), [states]);
  const total = payments.length;
  const unpaid = useMemo(() => unpaidLines(record), [record]);
  const unpaidTotal = useMemo(() => totalOf(unpaid.map((line) => payments[line - 1]!)), [unpaid, payments]);
  const show = (amount: bigint) => `${formatAmount(amount, token.decimals)} ${token.symbol}`;
  const overBalance = unpaidTotal > props.balance;

  // The latest run: how long it took and how fast it went.
  const run = record.run;
  const runTxs = run ? record.transactions.filter((tx) => tx.at >= run.startedAt && tx.outcome === 'paid') : [];
  const runPaid = runTxs.reduce((sum, tx) => sum + tx.lines.length, 0);
  const runSeconds =
    run?.endedAt !== undefined ? Math.round((Date.parse(run.endedAt) - Date.parse(run.startedAt)) / 1000) : undefined;

  // What went wrong, said once per transaction rather than once per line.
  const troubles = record.transactions
    .map((tx, index) => ({ tx, index }))
    .filter(({ tx }) => (tx.outcome === 'failed' || tx.outcome === 'unconfirmed') && tx.lines.some((line) => states[line - 1]?.tx === tx));

  /**
   * Check on chain what each test wallet received. For every paid transaction,
   * its bytes are fetched and opened with the key of each wallet it was meant
   * to pay. Lines whose address is not one of the test wallets are left alone:
   * the page has no key for them.
   */
  const checkReceipts = async () => {
    const saved = loadTestRecipients();
    if (!saved) return;
    stopChecking.current = false;
    setCheckError(null);
    try {
      setChecking('Making the test wallets’ keys…');
      const wallets = await deriveRecipients(saved.mnemonic, saved.count);
      const byAddress = new Map(wallets.map((wallet) => [wallet.address, wallet]));
      // Per paid transaction: the test wallets it paid, and the lines and total each was owed.
      const work = record.transactions
        .filter((tx) => tx.outcome === 'paid' && tx.txHash)
        .map((tx) => {
          const owed = new Map<string, { lines: number[]; amount: bigint }>();
          for (const line of tx.lines) {
            const payment = payments[line - 1];
            if (!payment || states[line - 1]?.tx !== tx || !byAddress.has(payment.recipient)) continue;
            const entry = owed.get(payment.recipient) ?? { lines: [], amount: 0n };
            entry.lines.push(line);
            entry.amount += payment.amount;
            owed.set(payment.recipient, entry);
          }
          return { tx, owed };
        })
        .filter(({ owed }) => owed.size > 0);
      const total = work.reduce((sum, { owed }) => sum + owed.size, 0);
      if (total === 0) {
        setCheckError('None of the paid lines is one of the test wallets made in this browser, so there is no key to check them with.');
        return;
      }
      const results = new Map<number, Receipt>();
      let done = 0;
      for (const { tx, owed } of work) {
        if (stopChecking.current) break;
        setChecking(`Checked ${done.toLocaleString('en')} of ${total.toLocaleString('en')} wallets…`);
        const raw = await props.fetchTx(tx.txHash!);
        if (!raw) throw new Error(`The indexer does not have transaction ${tx.txHash!.slice(0, 12)}….`);
        await receivedFrom(
          raw,
          [...owed.keys()].map((address) => byAddress.get(address)!),
          token.tokenType,
          (wallet, amount) => {
            const entry = owed.get(wallet.address)!;
            for (const line of entry.lines) results.set(line, { amount, ok: amount === entry.amount });
            done++;
            if (done % 4 === 0 || done === total) {
              setReceived(new Map(results));
              setChecking(`Checked ${done.toLocaleString('en')} of ${total.toLocaleString('en')} wallets…`);
            }
          },
          () => stopChecking.current,
        );
      }
      setReceived(new Map(results));
    } catch (cause) {
      setCheckError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setChecking(null);
    }
  };
  const receipts = [...received.values()];
  const receivedOk = receipts.filter((receipt) => receipt.ok).length;

  const download = () => {
    const csv = resultsCsv(
      payments,
      states,
      (amount) => formatAmount(amount, token.decimals),
      received.size > 0 ? (line) => received.get(line)?.amount : undefined,
    );
    const link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    link.download = 'payout-results.csv';
    link.click();
    URL.revokeObjectURL(link.href);
  };

  const rows = useMemo(() => {
    const matches = FILTERS.find((entry) => entry.key === filter)!.matches;
    return payments.flatMap((payment, index) => {
      const state = states[index] ?? { status: 'not sent' as const };
      if (!matches(state.status)) return [];
      const receipt = received.get(index + 1);
      return [
        <tr key={index} className={`line ${state.status.replace(' ', '-')}`}>
          <td className="num">{index + 1}</td>
          <td className="mono" title={payment.recipient}>
            {payment.recipient.slice(0, 34)}…{payment.recipient.slice(-8)}
          </td>
          <td className="num">{formatAmount(payment.amount, token.decimals)}</td>
          <td className="state" title={state.tx?.note}>
            {STATUS_LABEL[state.status]}
          </td>
          <td className="mono" title={state.tx?.txHash}>
            {state.tx?.txHash ? `${state.tx.txHash.slice(0, 12)}…` : ''}
          </td>
          {received.size > 0 && (
            <td className={`num ${receipt ? (receipt.ok ? 'paid' : 'failed') : ''}`}>
              {receipt ? `${formatAmount(receipt.amount, token.decimals)} ${receipt.ok ? '✓' : '✗'}` : ''}
            </td>
          )}
        </tr>,
      ];
    });
  }, [payments, states, filter, token.decimals, received]);

  const allPaid = counts.paid === total;
  return (
    <div className="board" data-testid="payout-board">
      <p className="headline">
        {running ? (
          <>
            <strong>
              Paying {wallets(run?.wallets ?? total)} in {run?.transactions ?? '?'} transactions.
            </strong>{' '}
            {counts.paid.toLocaleString('en')} of {total.toLocaleString('en')} on the list are paid.{' '}
            {run && <Elapsed since={Date.parse(run.startedAt)} />}
          </>
        ) : allPaid ? (
          <strong>All {wallets(total)} on this list are paid.</strong>
        ) : (
          <>
            <strong>
              {counts.paid.toLocaleString('en')} of {wallets(total)} are paid, {(total - counts.paid).toLocaleString('en')}{' '}
              are not.
            </strong>{' '}
            {run?.stopped}
          </>
        )}
      </p>
      {!running && run && runSeconds !== undefined && runPaid > 0 && (
        <p className="hint" data-testid="run-timing">
          Last run: {wallets(runPaid)} in {runTxs.length} {runTxs.length === 1 ? 'transaction' : 'transactions'} in{' '}
          {duration(runSeconds)}, which is {Math.round((runPaid * 60) / Math.max(1, runSeconds))} wallets a minute.
        </p>
      )}
      <progress value={counts.paid} max={total} />

      {troubles.length > 0 && (
        <ul className="troubles">
          {troubles.map(({ tx, index }) => (
            <li key={index} className={tx.outcome}>
              <strong>
                Lines {lineRanges(tx.lines)}: {tx.outcome === 'failed' ? 'not paid' : 'unconfirmed'}.
              </strong>{' '}
              {tx.note}
              {tx.outcome === 'unconfirmed' &&
                ' They are held back from sending again until the network says what became of this transaction.'}
            </li>
          ))}
        </ul>
      )}

      <div className="row-actions">
        {running ? (
          <button className="secondary" type="button" disabled={props.stopping} onClick={props.onStop}>
            {props.stopping ? 'Stopping after this transaction…' : 'Stop after this transaction'}
          </button>
        ) : (
          <>
            {unpaid.length > 0 && (
              <button type="button" disabled={props.busy || overBalance} onClick={props.onSendUnpaid} data-testid="send-unpaid">
                {counts.paid === 0 && counts.failed === 0
                  ? `Pay ${wallets(unpaid.length)}`
                  : `Send the ${wallets(unpaid.length)} not paid yet`}
              </button>
            )}
            {counts.unconfirmed > 0 && (
              <button type="button" className="secondary" disabled={props.busy} onClick={props.onCheck}>
                Check the {counts.unconfirmed} unconfirmed
              </button>
            )}
            {hasTestWallets && counts.paid > 0 && (
              <button
                type="button"
                className="secondary"
                disabled={checking !== null}
                onClick={() => void checkReceipts()}
                data-testid="check-receipts"
              >
                Check what each wallet received
              </button>
            )}
            <button type="button" className="secondary" onClick={download}>
              Download the results (CSV)
            </button>
            <button type="button" className="secondary" disabled={props.busy} onClick={props.onNew}>
              {allPaid ? 'Pay another list' : 'Close this list'}
            </button>
          </>
        )}
      </div>
      {checking !== null && (
        <p className="status" role="status" data-testid="check-progress">
          {checking}{' '}
          <button type="button" className="link" onClick={() => (stopChecking.current = true)}>
            Stop
          </button>
        </p>
      )}
      {checkError && <p className="field-error">{checkError}</p>}
      {checking === null && received.size > 0 && (
        <p className={receivedOk === receipts.length ? 'paid' : 'field-error'} data-testid="check-result">
          Checked on chain with the test wallets' own keys: {receivedOk.toLocaleString('en')} of{' '}
          {receipts.length.toLocaleString('en')} lines received exactly what they were sent.
        </p>
      )}
      {!running && unpaid.length > 0 && overBalance && (
        <p className="field-error">
          The unpaid lines add up to {show(unpaidTotal)}, more than the {show(props.balance)} you can spend.
        </p>
      )}

      <div className="chips" role="tablist" aria-label="Which lines to show">
        {FILTERS.map((entry) => {
          const matching = states.reduce((sum, state) => sum + (entry.matches(state.status) ? 1 : 0), 0);
          if (entry.key !== 'all' && entry.key !== 'paid' && matching === 0) return null;
          return (
            <button
              key={entry.key}
              type="button"
              role="tab"
              aria-selected={filter === entry.key}
              className={`chip ${entry.key}`}
              onClick={() => setFilter(entry.key)}
            >
              {entry.label} <span className="count">{matching.toLocaleString('en')}</span>
            </button>
          );
        })}
      </div>

      <div className="table-wrap">
        <table className="lines">
          <thead>
            <tr>
              <th className="num">Line</th>
              <th>Address</th>
              <th className="num">Amount</th>
              <th>Status</th>
              <th>Transaction</th>
              {received.size > 0 && <th className="num">Received on chain</th>}
            </tr>
          </thead>
          <tbody>{rows}</tbody>
        </table>
        {rows.length === 0 && <p className="hint">No lines in this state.</p>}
      </div>

      <PayoutTransactions record={record} />
    </div>
  );
}

/** Every transaction of a payout: the lines it carried, how long it took and what became of it. */
export function PayoutTransactions({ record }: { record: PayoutRecord }) {
  return (
    <details className="transactions">
      <summary>The transactions ({record.transactions.length})</summary>
      <div className="table-wrap">
        <table className="lines">
          <thead>
            <tr>
              <th className="num">#</th>
              <th>Lines</th>
              <th className="num">Proving</th>
              <th className="num">Finalizing</th>
              <th>Outcome</th>
              <th>Transaction hash</th>
            </tr>
          </thead>
          <tbody>
            {record.transactions.map((tx, index) => (
              <tr key={index} className={`line ${tx.outcome}`}>
                <td className="num">{index + 1}</td>
                <td>{lineRanges(tx.lines)}</td>
                <td className="num">{tx.buildMs === undefined ? '' : `${Math.round(tx.buildMs / 1000)} s`}</td>
                <td className="num">{tx.finalizeMs === undefined ? '' : `${Math.round(tx.finalizeMs / 1000)} s`}</td>
                <td className="state" title={tx.note}>
                  {tx.outcome}
                </td>
                <td className="mono">{tx.txHash ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

/** The payout in four numbers, for the always-visible panel. */
export function PayoutCounts({ record, running }: { record: PayoutRecord; running: boolean }) {
  const counts = countStates(lineStates(record, running));
  const todo = counts['not sent'] + counts.waiting + counts.sending;
  return (
    <dl className="facts counts" data-testid="payout-counts">
      <dt>Paid</dt>
      <dd className="paid">
        {counts.paid.toLocaleString('en')} of {record.lineCount.toLocaleString('en')}
      </dd>
      {counts.failed > 0 && (
        <>
          <dt>Failed</dt>
          <dd className="failed">{counts.failed.toLocaleString('en')}</dd>
        </>
      )}
      {counts.unconfirmed > 0 && (
        <>
          <dt>Unconfirmed</dt>
          <dd className="unconfirmed">{counts.unconfirmed.toLocaleString('en')}</dd>
        </>
      )}
      {todo > 0 && (
        <>
          <dt>{running ? 'Still to send' : 'Not sent'}</dt>
          <dd>{todo.toLocaleString('en')}</dd>
        </>
      )}
    </dl>
  );
}
