// The way back to a payout in progress whose list is not on screen.
//
// A payout's record (which line numbers were paid) is stored; its list (the
// addresses and amounts) lives in memory only. So after the page was closed or
// reloaded there is a payout to continue and no list to continue it with. This
// screen says where the payout stands and takes the list back: from a file,
// pasted, or, for test wallets made by the page, made again from their
// recovery phrase. The list is accepted only if it is the very list the
// record belongs to, and then the board opens with every line in its state.
//
// A list that was only closed is still in memory, and opens with one button.
import { useMemo, useRef, useState } from 'react';
import { formatAmount, parseAmount } from './amounts';
import type { TokenInfo } from './backend';
import type { Payment } from './fanout';
import { parseList } from './list';
import { NETWORK_ID } from './network';
import { countStates, fingerprintOf, lineStates, listMismatch, type PayoutRecord } from './payout';
import { PayoutTransactions, wallets } from './PayoutPanel';
import { deriveRecipients, loadTestRecipients } from './recipients';

export function PayoutResume(props: {
  token: TokenInfo;
  record: PayoutRecord;
  /** True when the list was closed but is still in this page's memory. */
  inMemory: boolean;
  /** True while the page is busy with anything. */
  busy: boolean;
  /** Show the list that is still in memory. */
  onReopen: () => void;
  /** Show `payments`, which were checked to be the list of `record`. Nothing is sent. */
  onOpen: (payments: Payment[]) => void;
  onCheck: () => void;
  /** Leave this payout as it is and enter a different list. */
  onAnother: () => void;
  onForget: () => void;
}) {
  const { token, record } = props;
  const counts = useMemo(() => countStates(lineStates(record, false)), [record]);
  const total = record.lineCount;
  const allPaid = counts.paid === total;

  const [problem, setProblem] = useState<string | null>(null);
  const [working, setWorking] = useState<string | null>(null);
  const [pasting, setPasting] = useState(false);
  const [pasted, setPasted] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);

  /** Open the board if `payments` are the list in progress; otherwise say what differs. */
  const offer = async (payments: Payment[], otherwise?: string): Promise<void> => {
    const mismatch = listMismatch(record, payments.length, await fingerprintOf(payments));
    if (mismatch) setProblem(otherwise ?? mismatch);
    else props.onOpen(payments);
  };

  const offerText = async (text: string) => {
    setProblem(null);
    const parsed = parseList(text, token.decimals, NETWORK_ID);
    if (parsed.count === 0) setProblem('There are no lines in that.');
    else if (parsed.firstProblem) setProblem(`Line ${parsed.firstProblem.index + 1}: ${parsed.firstProblem.problem}`);
    else await offer(parsed.payments);
  };

  // Test wallets made by this page can be made again: the same phrase gives the same wallets.
  // The amount each was sent is not stored, so it is asked for.
  const [testWallets] = useState(loadTestRecipients);
  const canRemake = testWallets !== null && testWallets.count >= total;
  const [amountText, setAmountText] = useState('1');
  const amount = parseAmount(amountText, token.decimals);

  const remake = async () => {
    if (!testWallets || !amount.ok) return;
    setProblem(null);
    setWorking('Making the wallets…');
    try {
      const recipients = await deriveRecipients(testWallets.mnemonic, total, (done) =>
        setWorking(`Making the wallets: ${done.toLocaleString('en')} of ${total.toLocaleString('en')}…`),
      );
      await offer(
        recipients.map((recipient) => ({ recipient: recipient.address, amount: amount.value })),
        `The first ${wallets(total)} of the test batch at ${formatAmount(amount.value, token.decimals)} ${token.symbol} each are not the list in progress. If each was sent another amount, change it and try again. If the list was edited after it was made, load it from a file or paste it.`,
      );
    } catch (cause) {
      setProblem(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setWorking(null);
    }
  };

  return (
    <div className="board resume" data-testid="payout-resume">
      <p className="headline">
        {allPaid ? (
          <strong>All {wallets(total)} on this list are paid.</strong>
        ) : (
          <>
            <strong>
              A payout is in progress: {counts.paid.toLocaleString('en')} of {wallets(total)} are paid,{' '}
              {(total - counts.paid).toLocaleString('en')} are not.
            </strong>{' '}
            {record.run?.stopped}
          </>
        )}
      </p>
      <progress value={counts.paid} max={total} />
      {counts.unconfirmed > 0 && (
        <p className="hint">
          {wallets(counts.unconfirmed)} {counts.unconfirmed === 1 ? 'is' : 'are'} unconfirmed: the network has not
          said what became of their transaction. They are held back from sending again until it has.
        </p>
      )}

      {props.inMemory ? (
        <>
          <p>The list is still in this page's memory. Open it to see every line{allPaid ? '.' : ' and to send the rest.'}</p>
          <div className="row-actions">
            <button type="button" onClick={props.onReopen} data-testid="reopen-list">
              Open the list
            </button>
            {counts.unconfirmed > 0 && (
              <button type="button" className="secondary" disabled={props.busy} onClick={props.onCheck}>
                Check the {counts.unconfirmed} unconfirmed
              </button>
            )}
          </div>
        </>
      ) : (
        <>
          <p>
            <strong>{allPaid ? 'To see every line, load the same list again.' : 'To carry on, load the same list again.'}</strong>{' '}
            Addresses and amounts are kept only in this page's memory, so the list went when the page was closed or
            reloaded. What was kept is which line numbers were paid. The page checks that it is the same list and
            shows every line in its state
            {allPaid ? '.' : '. From there one button sends the lines not paid yet, and nobody is paid twice.'}
          </p>
          <div className="row-actions">
            <button type="button" disabled={working !== null} onClick={() => fileInput.current?.click()}>
              Load the list from a file
            </button>
            <input
              ref={fileInput}
              type="file"
              accept=".txt,.csv,text/plain"
              data-testid="resume-file"
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = '';
                if (file) void file.text().then(offerText);
              }}
            />
            <button type="button" className="secondary" disabled={working !== null} onClick={() => setPasting(!pasting)}>
              {pasting ? 'Hide the text box' : 'Paste the list'}
            </button>
            {counts.unconfirmed > 0 && (
              <button type="button" className="secondary" disabled={props.busy} onClick={props.onCheck}>
                Check the {counts.unconfirmed} unconfirmed
              </button>
            )}
          </div>
          {pasting && (
            <>
              <textarea
                className="mono"
                value={pasted}
                spellCheck={false}
                aria-label="The list in progress: one wallet per line, its shielded address and then the amount"
                onChange={(event) => setPasted(event.target.value)}
              />
              <div className="row-actions">
                <button type="button" disabled={pasted.trim() === '' || working !== null} onClick={() => void offerText(pasted)}>
                  Use this list
                </button>
              </div>
            </>
          )}
          {canRemake && (
            <div className="test-wallets" data-testid="resume-test-wallets">
              <p>
                <strong>Were these the test wallets made on this page?</strong> They can be made again from the
                recovery phrase kept in this browser.
              </p>
              <div className="fields">
                <label>
                  Amount each was sent, in {token.symbol}
                  <input inputMode="decimal" value={amountText} onChange={(event) => setAmountText(event.target.value)} />
                </label>
              </div>
              {!amount.ok && <p className="field-error">{amount.error}</p>}
              <button type="button" className="secondary" disabled={working !== null || !amount.ok} onClick={() => void remake()}>
                {working ?? `Make the ${wallets(total)} again`}
              </button>
            </div>
          )}
          {problem && (
            <p className="field-error" role="alert" data-testid="resume-problem">
              {problem}
            </p>
          )}
        </>
      )}

      <PayoutTransactions record={record} />

      <div className="row-actions leave">
        <button type="button" className="secondary" onClick={props.onAnother}>
          Pay a different list
        </button>
        <button type="button" className="secondary" disabled={props.busy} onClick={props.onForget}>
          Forget this payout
        </button>
      </div>
    </div>
  );
}
