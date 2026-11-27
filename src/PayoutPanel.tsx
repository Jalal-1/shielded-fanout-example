// The payout screen: load a list, pay it, and see what became of every line.
//
//   PayoutInput   the list as text or from a file, checked line by line
//   PayoutBoard   one row per line with its state, the transactions behind
//                 them, and the buttons to send what is still unpaid
//
// The sending itself is in src/App.tsx (`payList`), on top of src/fanout.ts.
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { checkShieldedAddress, shieldedAddressPrefix } from './address';
import { formatAmount, parseAmount } from './amounts';
import type { TokenInfo } from './backend';
import { RECIPIENTS_PER_TRANSACTION, SECONDS_PER_TRANSACTION, totalOf, type Payment } from './fanout';
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
const wallets = (count: number): string => `${count.toLocaleString('en')} ${count === 1 ? 'wallet' : 'wallets'}`;

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
  onDiscardRecord: () => void;
}) {
  const { token, record, balance } = props;

  // The recipients live here, in memory, and nowhere else.
  const [list, setList] = useState('');

  // One recipient per line: "address amount". One line pays one wallet, many lines pay many.
  // Checked once per edit, not on every refresh of the page: a list can be thousands of lines.
  const { count, firstProblem, payments } = useMemo(() => {
    const lines = list
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '');
    const parsed = lines.map((line, index) => {
      const [address = '', amountText = ''] = line.split(/[\s,;]+/);
      const amount = parseAmount(amountText, token.decimals);
      const problem =
        checkShieldedAddress(address, NETWORK_ID) ??
        (amountText === '' ? 'Add the amount after the address.' : amount.ok ? null : amount.error);
      return { index, address, amount, problem };
    });
    const firstProblem = parsed.find((line) => line.problem !== null);
    const payments: Payment[] = firstProblem
      ? []
      : parsed.flatMap((line) => (line.amount.ok ? [{ recipient: line.address, amount: line.amount.value }] : []));
    return { count: lines.length, firstProblem, payments };
  }, [list, token.decimals]);
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
            <strong>A payout list is in progress in this browser:</strong>{' '}
            {recordCounts.paid.toLocaleString('en')} of {wallets(record.lineCount)} paid
            {recordCounts.unconfirmed > 0 && `, ${recordCounts.unconfirmed.toLocaleString('en')} unconfirmed`}.{' '}
            Load the same list to see every line and to send the rest. Nobody is paid twice.
          </p>
          <button type="button" className="secondary" disabled={props.disabled} onClick={props.onDiscardRecord}>
            Forget that list
          </button>
        </div>
      )}

      <BalanceLine token={token} balance={balance} arriving={props.arriving} />

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

// ── What became of every line ────────────────────────────────────────────────

type Filter = 'all' | 'paid' | 'problem' | 'unconfirmed' | 'todo';

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
}) {
  const { token, payments, record, running } = props;
  const [filter, setFilter] = useState<Filter>('all');

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

  const download = () => {
    const csv = resultsCsv(payments, states, (amount) => formatAmount(amount, token.decimals));
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
        </tr>,
      ];
    });
  }, [payments, states, filter, token.decimals]);

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
            <button type="button" className="secondary" onClick={download}>
              Download the results (CSV)
            </button>
            <button type="button" className="secondary" disabled={props.busy} onClick={props.onNew}>
              {allPaid ? 'Pay another list' : 'Close this list'}
            </button>
          </>
        )}
      </div>
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
            </tr>
          </thead>
          <tbody>{rows}</tbody>
        </table>
        {rows.length === 0 && <p className="hint">No lines in this state.</p>}
      </div>

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
    </div>
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
