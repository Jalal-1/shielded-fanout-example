// The whole user interface: connect, fund, deploy, mint, pay out.
//
// The interesting code is elsewhere and this file only calls it:
//   src/fanout.ts   the payout (one transaction, many recipients)
//   src/wallet.ts   finding and connecting a wallet, reading balances
//   src/backend.ts  deploying and minting the token
import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import type { InitialAPI } from '@midnight-ntwrk/dapp-connector-api';
import { checkShieldedAddress } from './address';
import { formatAmount, parseAmount } from './amounts';
import type { Backend, TokenInfo } from './backend';
import { LARGEST_VERIFIED_RECIPIENT_COUNT, sendFanout, totalOf, type Payment } from './fanout';
import { loadPayout, loadToken, randomHex32, savePayout, saveToken, type StoredPayout, type StoredToken } from './storage';
import {
  DUST_DECIMALS,
  FAUCET_URL,
  NETWORK_ID,
  NIGHT_DECIMALS,
  connectWallet,
  explainError,
  listWallets,
  readFunds,
  readTokenBalance,
  type Funds,
  type Session,
} from './wallet';

export interface AppProps {
  readonly backend: Backend;
  /** Mock mode only: addresses the "fill sample recipients" button uses. */
  readonly sampleAddresses?: readonly string[];
  /** How often to re-read a balance while waiting for it to change. */
  readonly pollMs?: number;
}

interface Row {
  readonly id: number;
  readonly address: string;
  readonly amount: string;
}

/** How long to wait for the indexer to report a transaction as finalized. */
const FINALIZATION_WAIT_MS = 5 * 60_000;

export function App({ backend, sampleAddresses, pollMs = 2000 }: AppProps) {
  const [wallets, setWallets] = useState<InitialAPI[]>(() => listWallets());
  const [session, setSession] = useState<Session | null>(null);
  const [funds, setFunds] = useState<Funds | null>(null);
  const [stored, setStored] = useState<StoredToken | undefined>();
  const [balance, setBalance] = useState(0n);
  const [payout, setPayout] = useState<StoredPayout | undefined>();
  // True once a status check found nothing, which is when a retry may be offered.
  const [payoutUnseen, setPayoutUnseen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const token = stored?.info;
  const account = session?.shieldedCoinPublicKey;
  const hasDust = (funds?.dust ?? 0n) > 0n;

  // Wallet extensions add themselves to the page a moment after it loads.
  useEffect(() => {
    if (session) return;
    const timer = setInterval(() => setWallets(listWallets()), 500);
    return () => clearInterval(timer);
  }, [session]);

  /** Run one user action: show what is happening, and explain any failure. */
  const run = useCallback(async (label: string, action: () => Promise<void>) => {
    setBusy(label);
    setError(null);
    try {
      await action();
    } catch (cause) {
      console.error(cause);
      setError(explainError(cause));
    } finally {
      setBusy(null);
    }
  }, []);

  const refreshFunds = useCallback(async (current: Session) => setFunds(await readFunds(current.api)), []);

  /** Re-read the token balance until it differs from `before`, or give up. */
  const waitForBalanceChange = useCallback(
    async (current: Session, tokenType: string, before: bigint) => {
      for (let attempt = 0; attempt < 45; attempt++) {
        const now = await readTokenBalance(current.api, tokenType);
        setBalance(now);
        if (now !== before) return;
        await new Promise((resolve) => setTimeout(resolve, pollMs));
      }
    },
    [pollMs],
  );

  const connect = (wallet: InitialAPI) =>
    run('Waiting for your wallet to connect…', async () => {
      const next = await connectWallet(wallet);
      setSession(next);
      await refreshFunds(next);
      const savedToken = loadToken(next.shieldedCoinPublicKey);
      setStored(savedToken);
      setPayout(loadPayout(next.shieldedCoinPublicKey));
      if (savedToken?.info) setBalance(await readTokenBalance(next.api, savedToken.info.tokenType));
    });

  const recheck = () =>
    run('Reading your balances…', async () => {
      if (!session) return;
      await refreshFunds(session);
      if (token) setBalance(await readTokenBalance(session.api, token.tokenType));
    });

  const deploy = (name: string, symbol: string, decimals: number) =>
    run('Deploying your token. Approve it in your wallet, then keep this tab open…', async () => {
      if (!session || !account) return;
      const meta = { name, symbol, decimals };
      // Save the secrets BEFORE deploying. If the page closes mid-deploy, the
      // owner's nonce must not be lost with it.
      const secrets = stored?.secrets ?? { secretNonce: randomHex32(), instanceSalt: randomHex32() };
      saveToken(account, { meta, secrets });
      const info = await backend.deployToken(session, meta, secrets);
      const next = { meta, secrets, info };
      saveToken(account, next);
      setStored(next);
      setBalance(0n);
      await refreshFunds(session);
    });

  const mint = (amount: bigint) =>
    run('Minting. Approve it in your wallet…', async () => {
      if (!session || !stored?.info) return;
      const before = await readTokenBalance(session.api, stored.info.tokenType);
      await backend.mint(session, stored.info, stored.secrets, amount);
      setBusy('Minted. Waiting for your wallet to show the new coins…');
      await waitForBalanceChange(session, stored.info.tokenType, before);
      await refreshFunds(session);
    });

  const rememberPayout = useCallback(
    (next: StoredPayout | undefined) => {
      if (account) savePayout(account, next);
      setPayout(next);
    },
    [account],
  );

  /** Ask the indexer about the stored payout and record what it says. */
  const followPayout = useCallback(
    async (current: Session, sent: StoredPayout, maxWaitMs: number) => {
      const outcome = await backend.checkTx(current, sent.txId, maxWaitMs);
      if (outcome === 'pending') {
        setPayoutUnseen(true);
        return;
      }
      setPayoutUnseen(false);
      rememberPayout({ ...sent, status: outcome });
    },
    [backend, rememberPayout],
  );

  const send = (payments: Payment[]) =>
    run('Waiting for your wallet. Approve the payout; it then builds and proves the transaction…', async () => {
      if (!session || !token) return;
      const before = await readTokenBalance(session.api, token.tokenType);
      // If submitting fails after the wallet built the transaction, its hash
      // stays on screen as "built", so the user can check whether it went out.
      let sent: StoredPayout | undefined;
      await sendFanout(session.api, token.tokenType, payments, (tx) => {
        // Store the hash before submitting, so a refresh cannot lose it.
        sent = { ...backend.describeTx(tx), status: 'built', at: new Date().toISOString() };
        rememberPayout(sent);
        setPayoutUnseen(false);
        setBusy('Submitting the payout…');
      });
      if (!sent) return;
      sent = { ...sent, status: 'submitted' };
      rememberPayout(sent);
      setBusy('Submitted. Waiting for the payout to finalize…');
      await followPayout(session, sent, FINALIZATION_WAIT_MS);
      await waitForBalanceChange(session, token.tokenType, before);
      await refreshFunds(session);
    });

  const checkPayout = () =>
    run('Checking the payout…', async () => {
      if (session && payout) await followPayout(session, payout, 15_000);
    });

  return (
    <main>
      <header>
        <h1>Shielded fanout</h1>
        <p>
          Mint your own shielded token on Midnight Preprod, then pay several wallets in <strong>one transaction</strong>.
        </p>
        {sampleAddresses && (
          <p className="notice">Mock mode. The wallet and the chain are pretend, and nothing leaves this page.</p>
        )}
      </header>

      {busy && (
        <p className="status" role="status">
          {busy}
        </p>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      <Step number={1} title="Connect a wallet" done={!!session}>
        {session ? (
          <dl>
            <dt>Wallet</dt>
            <dd>{session.walletName}</dd>
            <dt>Network</dt>
            <dd>Preprod</dd>
            <dt>Your shielded address</dt>
            <dd className="mono">{session.shieldedAddress}</dd>
          </dl>
        ) : wallets.length === 0 ? (
          <p>
            No compatible Midnight wallet found in this browser. Install a wallet that supports DApp Connector 4.x, set
            it to Preprod, and reload.
          </p>
        ) : (
          wallets.map((wallet) => (
            <button key={wallet.rdns || wallet.name} disabled={!!busy} onClick={() => connect(wallet)}>
              Connect {wallet.name}
            </button>
          ))
        )}
      </Step>

      <Step number={2} title="Fund your wallet" done={hasDust} locked={!session && 'Connect a wallet first.'}>
        {funds && (
          <>
            <dl>
              <dt>tNIGHT</dt>
              <dd>{formatAmount(funds.night, NIGHT_DECIMALS)}</dd>
              <dt>tDUST</dt>
              <dd>{formatAmount(funds.dust, DUST_DECIMALS)}</dd>
            </dl>
            {!hasDust && (
              <div className="notice">
                <p>You need tDUST to pay transaction fees. This site cannot do it for you:</p>
                <ol>
                  <li>
                    Get tNIGHT from the{' '}
                    <a href={FAUCET_URL} target="_blank" rel="noreferrer">
                      Preprod faucet
                    </a>
                    .
                  </li>
                  <li>In your wallet, use that tNIGHT to generate tDUST, and wait for some to appear.</li>
                </ol>
              </div>
            )}
            <button className="secondary" disabled={!!busy} onClick={recheck}>
              Check balances again
            </button>
          </>
        )}
      </Step>

      <Step
        number={3}
        title="Deploy your token"
        done={!!token}
        locked={!session ? 'Connect a wallet first.' : !hasDust && !token && 'You need tDUST first.'}
      >
        {token ? (
          <>
            <dl>
              <dt>Token</dt>
              <dd>
                {token.name} ({token.symbol}), {token.decimals} decimals
              </dd>
              <dt>Contract address</dt>
              <dd className="mono">{token.contractAddress}</dd>
              <dt>Token type</dt>
              <dd className="mono">{token.tokenType}</dd>
            </dl>
            <p className="hint">
              Only this browser can mint this token. The owner's secret is kept in this site's storage, so clearing site
              data removes the ability to mint for good.
            </p>
          </>
        ) : (
          <DeployForm disabled={!!busy} onDeploy={deploy} />
        )}
      </Step>

      <Step
        number={4}
        title="Mint"
        locked={!token ? 'Deploy your token first.' : !hasDust && 'You need tDUST first.'}
      >
        {token && (
          <>
            <p>
              Spendable balance:{' '}
              <strong data-testid="balance">
                {formatAmount(balance, token.decimals)} {token.symbol}
              </strong>
            </p>
            <MintForm token={token} disabled={!!busy} onMint={mint} />
          </>
        )}
      </Step>

      <Step
        number={5}
        title="Pay several wallets at once"
        locked={!token ? 'Deploy and mint your token first.' : !hasDust && 'You need tDUST first.'}
      >
        {token && (
          <>
            {payout && (
              <PayoutStatus
                payout={payout}
                unseen={payoutUnseen}
                disabled={!!busy}
                onCheck={checkPayout}
                onClear={() => rememberPayout(undefined)}
              />
            )}
            {(!payout || payout.status === 'finalized' || payout.status === 'failed') && (
              <PayoutForm
                token={token}
                balance={balance}
                disabled={!!busy}
                sampleAddresses={sampleAddresses}
                onSend={send}
              />
            )}
          </>
        )}
      </Step>

      <footer>
        <p>
          Recipient addresses and amounts stay in this page's memory. They are never stored or sent anywhere except to
          your wallet.
        </p>
      </footer>
    </main>
  );
}

function Step(props: { number: number; title: string; done?: boolean; locked?: string | false; children: ReactNode }) {
  return (
    <section className={props.locked ? 'step locked' : 'step'} aria-labelledby={`step-${props.number}`}>
      <h2 id={`step-${props.number}`}>
        <span className="number">{props.done ? '✓' : props.number}</span> {props.title}
      </h2>
      {props.locked ? <p className="hint">{props.locked}</p> : props.children}
    </section>
  );
}

function DeployForm(props: { disabled: boolean; onDeploy: (name: string, symbol: string, decimals: number) => void }) {
  const [name, setName] = useState('Fanout Demo');
  const [symbol, setSymbol] = useState('FAN');
  const [decimals, setDecimals] = useState('2');
  const decimalsValue = Number(decimals);
  const valid =
    name.trim() !== '' && symbol.trim() !== '' && Number.isInteger(decimalsValue) && decimalsValue >= 0 && decimalsValue <= 18;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (valid) props.onDeploy(name.trim(), symbol.trim(), decimalsValue);
  };

  return (
    <form onSubmit={submit}>
      <p>This deploys a new token contract that your wallet owns. Only you can mint it.</p>
      <div className="fields">
        <label>
          Name
          <input value={name} maxLength={32} onChange={(event) => setName(event.target.value)} />
        </label>
        <label>
          Symbol
          <input value={symbol} maxLength={8} onChange={(event) => setSymbol(event.target.value)} />
        </label>
        <label>
          Decimals
          <input value={decimals} inputMode="numeric" onChange={(event) => setDecimals(event.target.value)} />
        </label>
      </div>
      <button type="submit" disabled={props.disabled || !valid}>
        Deploy token
      </button>
    </form>
  );
}

function MintForm(props: { token: TokenInfo; disabled: boolean; onMint: (amount: bigint) => void }) {
  const [text, setText] = useState('100');
  const parsed = parseAmount(text, props.token.decimals);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (parsed.ok) props.onMint(parsed.value);
  };

  return (
    <form onSubmit={submit}>
      <div className="fields">
        <label>
          Amount to mint
          <input value={text} inputMode="decimal" onChange={(event) => setText(event.target.value)} />
        </label>
      </div>
      {!parsed.ok && text !== '' && <p className="field-error">{parsed.error}</p>}
      <button type="submit" disabled={props.disabled || !parsed.ok}>
        Mint to my wallet
      </button>
    </form>
  );
}

function PayoutForm(props: {
  token: TokenInfo;
  balance: bigint;
  disabled: boolean;
  sampleAddresses?: readonly string[];
  onSend: (payments: Payment[]) => void;
}) {
  const { token, balance } = props;
  const nextId = useRef(2);
  // Recipients live here, in memory, and nowhere else.
  const [rows, setRows] = useState<Row[]>([
    { id: 0, address: '', amount: '' },
    { id: 1, address: '', amount: '' },
  ]);

  const update = (id: number, change: Partial<Row>) =>
    setRows((current) => current.map((row) => (row.id === id ? { ...row, ...change } : row)));

  const checked = rows.map((row) => ({
    row,
    addressError: row.address === '' ? null : checkShieldedAddress(row.address, NETWORK_ID),
    amount: parseAmount(row.amount, token.decimals),
  }));
  const payments: Payment[] = checked.flatMap(({ row, addressError, amount }) =>
    row.address !== '' && addressError === null && amount.ok ? [{ recipient: row.address.trim(), amount: amount.value }] : [],
  );
  const complete = payments.length === rows.length;
  const total = totalOf(payments);
  const overBalance = total > balance;
  const overVerified = LARGEST_VERIFIED_RECIPIENT_COUNT !== null && rows.length > LARGEST_VERIFIED_RECIPIENT_COUNT;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (complete && !overBalance) props.onSend(payments);
  };

  return (
    <form onSubmit={submit}>
      <p>
        Spendable balance:{' '}
        <strong>
          {formatAmount(balance, token.decimals)} {token.symbol}
        </strong>
      </p>

      {checked.map(({ row, addressError, amount }, index) => (
        <fieldset key={row.id} className="recipient">
          <legend>Recipient {index + 1}</legend>
          <label>
            Shielded address
            <input
              className="mono"
              value={row.address}
              placeholder="mn_shield-addr_preprod1…"
              spellCheck={false}
              autoComplete="off"
              onChange={(event) => update(row.id, { address: event.target.value })}
            />
          </label>
          {addressError && <p className="field-error">{addressError}</p>}
          <label>
            Amount ({token.symbol})
            <input
              value={row.amount}
              inputMode="decimal"
              autoComplete="off"
              onChange={(event) => update(row.id, { amount: event.target.value })}
            />
          </label>
          {!amount.ok && row.amount !== '' && <p className="field-error">{amount.error}</p>}
          {rows.length > 1 && (
            <button
              type="button"
              className="secondary"
              onClick={() => setRows((current) => current.filter((other) => other.id !== row.id))}
            >
              Remove recipient {index + 1}
            </button>
          )}
        </fieldset>
      ))}

      <div className="row-actions">
        <button
          type="button"
          className="secondary"
          onClick={() => setRows((current) => [...current, { id: nextId.current++, address: '', amount: '' }])}
        >
          Add recipient
        </button>
        {props.sampleAddresses && (
          <button
            type="button"
            className="secondary"
            onClick={() =>
              setRows((current) =>
                current.map((row, index) => ({ ...row, address: props.sampleAddresses?.[index] ?? row.address })),
              )
            }
          >
            Fill sample addresses
          </button>
        )}
      </div>

      <dl>
        <dt>Total to send</dt>
        <dd data-testid="total">
          {formatAmount(total, token.decimals)} {token.symbol}
        </dd>
        <dt>Left in your wallet afterwards</dt>
        <dd data-testid="remaining">{overBalance ? '—' : `${formatAmount(balance - total, token.decimals)} ${token.symbol}`}</dd>
        <dt>Fee</dt>
        <dd>Paid in tDUST. Your wallet works it out and shows it when you approve.</dd>
      </dl>

      {overBalance && <p className="field-error">The total is more than your spendable balance.</p>}
      {rows.length > 2 && (
        <p className={overVerified ? 'field-error' : 'hint'}>
          A transaction has a size limit, so a long list may not fit in one. Largest payout verified on Preprod so far:{' '}
          {LARGEST_VERIFIED_RECIPIENT_COUNT === null ? 'none recorded yet' : `${LARGEST_VERIFIED_RECIPIENT_COUNT} recipients`}.
        </p>
      )}

      <button type="submit" disabled={props.disabled || !complete || overBalance}>
        Send {rows.length} {rows.length === 1 ? 'payment' : 'payments'} in one transaction
      </button>
    </form>
  );
}

const PAYOUT_LABELS: Record<StoredPayout['status'], string> = {
  built: 'Built by your wallet, but this page did not see it submitted',
  submitted: 'Submitted, not finalized yet',
  finalized: 'Finalized',
  failed: 'Failed on chain. Nothing was paid',
};

function PayoutStatus(props: {
  payout: StoredPayout;
  unseen: boolean;
  disabled: boolean;
  onCheck: () => void;
  onClear: () => void;
}) {
  const { payout } = props;
  const settled = payout.status === 'finalized' || payout.status === 'failed';
  return (
    <div className={payout.status === 'finalized' ? 'payout success' : 'payout'}>
      <dl>
        <dt>Last payout</dt>
        <dd data-testid="payout-status">{PAYOUT_LABELS[payout.status]}</dd>
        <dt>Transaction hash</dt>
        <dd className="mono" data-testid="payout-hash">
          {payout.txHash}
        </dd>
      </dl>
      {!settled && (
        <>
          <button className="secondary" disabled={props.disabled} onClick={props.onCheck}>
            Check its status
          </button>
          {props.unseen && (
            <>
              <p className="hint">
                The network has not reported this transaction. It may still arrive, so check your wallet's history
                before paying again, or the recipients could be paid twice.
              </p>
              <button className="secondary" disabled={props.disabled} onClick={props.onClear}>
                Start a new payout
              </button>
            </>
          )}
        </>
      )}
    </div>
  );
}
