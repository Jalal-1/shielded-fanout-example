// The user interface: wallet, NIGHT, DUST, token, mint, pay out.
//
// The interesting code is elsewhere and this file only calls it:
//   src/wallet/browser-wallet.ts   the wallet (wallet SDK), including the payout
//   src/fanout.ts                  the payout in a dozen lines
//   src/payout.ts                  which line of a list was paid, and which was not
//   src/PayoutPanel.tsx            the payout screen
//   src/PayoutResume.tsx           the way back to a payout whose list is not on screen
//   src/midnight/real-backend.ts   deploying and minting the token (Midnight.js)
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import type { FacadeState } from 'fanout-wallet-sdk';
import { formatAmount, parseAmount } from './amounts';
import type { Stage, TokenInfo } from './backend';
import { describeError, diag, onActivity, type ActivityLine } from './diag';
import { inBatches, sendFanout, totalOf, type Payment } from './fanout';
import { createRealBackend } from './midnight/real-backend';
import { DEFAULT_PROOF_SERVER, DUST, NETWORK, NETWORKS, NIGHT, chainEndpoints, switchNetwork, type NetworkId } from './network';
import {
  UNCONFIRMED_EXPIRES_MS,
  afterReload,
  lineStates,
  unpaidLines,
  withTx,
  type PayoutRecord,
  type PayoutTx,
} from './payout';
import { PayoutBoard, PayoutCounts, PayoutInput } from './PayoutPanel';
import { PayoutResume } from './PayoutResume';
import { loadPayoutRecord, loadToken, randomHex32, savePayoutRecord, saveToken, type StoredToken } from './storage';
import { BalanceLine, Elapsed } from './widgets';
import logo from './assets/midnight-logo.svg';
import { BrowserWallet, type WalletView } from './wallet/browser-wallet';
import {
  forgetSeed,
  forgetWalletState,
  loadSeed,
  markWalletAsNew,
  newSeed,
  saveSeed,
  walletIsNoLongerNew,
} from './wallet/wallet-store';

/** How long to wait for the indexer to report a transaction as finalized. */
const FINALIZATION_WAIT_MS = 5 * 60_000;

/** Between two transactions of a run: how long to wait for the first one's change to become spendable. */
const CHANGE_WAIT_MS = 3 * 60_000;

/** How often to try building one transaction before giving up on it. */
const BUILD_ATTEMPTS = 4;

const NIGHT_DECIMALS = 6;

/** DUST has fifteen decimals. Three are shown: the rest are noise on screen. */
const formatDust = (dust: bigint): string => formatAmount(dust / 10n ** 12n, 3);

/** Roughly what deploying the token costs in DUST, from real runs on Preprod. */
const DEPLOY_COST_DUST = 11n * 10n ** 15n;

/** What to tell the user at each stage of a contract transaction. */
function stageText(what: string, stage: Stage): string {
  switch (stage) {
    case 'preparing':
      return `${what}: preparing the transaction…`;
    case 'proving':
      return `${what}: the proof server is building the proof…`;
    case 'signing':
      return `${what}: adding the ${DUST} fee and signing…`;
    case 'submitting':
      return `${what}: submitting to the node…`;
    case 'finalizing':
      return `${what}: submitted. Waiting for the network to finalize it…`;
  }
}

/** Turn anything thrown into one plain sentence. */
function explainError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  if (/429|too many requests/i.test(text)) {
    return 'The proof server refused the work: too many proofs at once. Start it with a larger job capacity (see `pnpm proof:up`) and try again.';
  }
  if (/failed to fetch|networkerror|load failed/i.test(text)) {
    return `A network request failed (${text}). Check that the proof server is running and that the Blockfrost project ID is right.`;
  }
  // The wallet's own "not enough DUST" message is already a full sentence.
  if (/insufficient funds/i.test(text) && /dust/i.test(text)) {
    return `The wallet could not pay the fee: ${text}`;
  }
  return text;
}

// ── Settings: where the chain and the prover are ─────────────────────────────

const PROOF_SERVER_KEY = 'shielded-fanout:proof-server';

/** The proof server the user chose, or the default. */
const loadProofServer = (): string => localStorage.getItem(PROOF_SERVER_KEY)?.trim() || DEFAULT_PROOF_SERVER;

export interface AppProps {
  /** How often the numbers on screen are refreshed from the wallet. */
  readonly refreshMs?: number;
}

export function App({ refreshMs = 1000 }: AppProps) {
  const [proofServer] = useState(loadProofServer);
  const endpoints = useMemo(() => chainEndpoints(proofServer), [proofServer]);
  const backend = useMemo(() => createRealBackend(endpoints), [endpoints]);

  const [seed, setSeed] = useState<string | null>(loadSeed);
  const [wallet, setWallet] = useState<BrowserWallet | null>(null);
  const [view, setView] = useState<WalletView | null>(null);
  // `stored` is what this browser saved. `token` is what the chain confirmed:
  // only that is ever shown as a deployed contract.
  const [stored, setStored] = useState<StoredToken | undefined>();
  const [token, setToken] = useState<TokenInfo | null>(null);
  const [missing, setMissing] = useState<string | null>(null);
  const [activity, setActivity] = useState<ActivityLine[]>([]);
  // The payout list being paid: the list itself (in memory only), and the
  // record of which of its lines went into which transaction (stored).
  const [list, setList] = useState<Payment[] | null>(null);
  const [record, setRecord] = useState<PayoutRecord | undefined>();
  // Whether the list is on screen. A list that was closed with lines still unpaid
  // stays in memory, so going back to it does not mean loading it again.
  const [listOpen, setListOpen] = useState(false);
  // True once the user chose to enter a different list than the one in progress.
  const [another, setAnother] = useState(false);
  const [stopping, setStopping] = useState(false);
  const stopRequested = useRef(false);
  // Which step is on screen, once the user or the flow has chosen one.
  const [picked, setPicked] = useState<number | null>(null);
  const furthestStep = useRef(1);
  const [busy, setBusyText] = useState<string | null>(null);
  const [busySince, setBusySince] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [proofServerUp, setProofServerUp] = useState<boolean | null>(null);
  const opening = useRef(false);

  const account = wallet?.coinPublicKey;
  const synced = view?.synced ?? false;
  const dust = view?.dust ?? 0n;
  // DUST tied up in a transaction counts as having DUST: with one DUST coin the balance reads
  // zero for a few blocks after every fee, and the page must not act as if there were none.
  const dustBusy = view?.dustBusy ?? false;
  const hasDust = dust > 0n || dustBusy;
  const balance = token && view ? (view.shielded[token.tokenType] ?? 0n) : 0n;
  // Change on its way back from a transaction that has not finalized yet.
  const arriving = token && view ? (view.shieldedArriving[token.tokenType] ?? 0n) : 0n;
  const canMint = !!token && !!stored?.secrets;

  /** Show what is happening now, and restart the clock beside it. */
  const setBusy = useCallback((text: string | null) => {
    setBusyText(text);
    setBusySince(Date.now());
  }, []);

  // Every step the app takes is listed on the page as it happens.
  useEffect(() => onActivity((line) => setActivity((lines) => [...lines.slice(-39), line])), []);

  // Is the proof server there? Nothing can be proven without it.
  useEffect(() => {
    let current = true;
    let misses = 0;
    // A busy proof server can be slow to answer, so one miss is not an outage.
    const check = () =>
      fetch(new URL('/version', proofServer), { signal: AbortSignal.timeout(5_000) })
        .then((response) => response.ok)
        .catch(() => false)
        .then((up) => {
          misses = up ? 0 : misses + 1;
          if (current && (up || misses >= 2)) setProofServerUp(up);
        });
    void check();
    const timer = setInterval(check, 15_000);
    return () => {
      current = false;
      clearInterval(timer);
    };
  }, [proofServer]);

  /** Run one user action: show what is happening, and explain any failure. */
  const run = useCallback(
    async (label: string, action: () => Promise<void>) => {
      setBusy(label);
      setError(null);
      diag(`action: ${label}`);
      try {
        await action();
        diag('action: done');
      } catch (cause) {
        console.error(cause);
        diag('action: FAILED', { shown: explainError(cause), error: describeError(cause) });
        setError(explainError(cause));
      } finally {
        setBusy(null);
      }
    },
    [setBusy],
  );

  /**
   * Ask the network what became of every transaction still marked unconfirmed.
   * Finalized means its lines were paid; failed means they were not. One the
   * network has never seen stays unconfirmed, and its lines are held back,
   * until its validity has run out AND the indexer confirms it has no such
   * transaction: only then is it certain that sending again pays nobody twice.
   */
  const settleUnconfirmed = useCallback(
    async (from: BrowserWallet, start: PayoutRecord, maxWaitMs: number): Promise<PayoutRecord> => {
      let next = start;
      for (const [index, tx] of start.transactions.entries()) {
        if (tx.outcome !== 'unconfirmed' || !tx.txId) continue;
        const outcome = await backend.checkTx(from, tx.txId, maxWaitMs);
        diag(`payout: transaction ${index + 1} was unconfirmed; the network now says: ${outcome}`);
        if (outcome === 'finalized') {
          next = withTx(next, index, { ...tx, outcome: 'paid', note: undefined });
        } else if (outcome === 'failed') {
          next = withTx(next, index, { ...tx, outcome: 'failed', note: 'This transaction failed on chain. Nothing in it was paid.' });
        } else if (
          Date.now() - Date.parse(tx.at) > UNCONFIRMED_EXPIRES_MS &&
          (await backend.txIsAbsent(tx.txId).catch(() => false))
        ) {
          next = withTx(next, index, {
            ...tx,
            outcome: 'failed',
            note: 'The network never included this transaction and its 30 minutes of validity have run out. Nothing in it was paid.',
          });
        }
      }
      return next;
    },
    [backend],
  );

  // Open the wallet as soon as there is a seed and somewhere to connect to.
  useEffect(() => {
    if (!seed || wallet || opening.current) return;
    opening.current = true;
    void run('Opening your wallet…', async () => {
      const opened = await BrowserWallet.open(seed, endpoints, (step) => {
        diag(`wallet: ${step}`);
        setBusy(`Opening your wallet: ${step}…`);
      });
      setWallet(opened);

      // A saved contract counts only if the chain has it.
      const savedToken = loadToken(opened.coinPublicKey);
      setStored(savedToken);
      // A payout list this page was in the middle of: pick its record up again.
      const savedRecord = loadPayoutRecord(opened.coinPublicKey);
      let restored = savedRecord ? afterReload(savedRecord) : undefined;
      if (restored) savePayoutRecord(opened.coinPublicKey, restored);
      setRecord(restored);
      if (savedToken?.info) {
        setBusy(`Checking your saved contract on ${NETWORK.label}…`);
        try {
          const onChain = await backend.readToken(opened, savedToken.info.contractAddress);
          if (onChain) setToken(onChain);
          else setMissing(savedToken.info.contractAddress);
        } catch (cause) {
          // The indexer did not answer. Not fatal: the effect below keeps asking.
          diag('saved contract could not be read yet; trying again shortly', describeError(cause));
        }
      }
      // A transaction this page did not see through (the tab was reloaded
      // part-way): ask the chain what became of it rather than leave it open.
      if (restored?.transactions.some((tx) => tx.outcome === 'unconfirmed')) {
        setBusy('Checking what became of the payout from before the reload…');
        restored = await settleUnconfirmed(opened, restored, 45_000);
        savePayoutRecord(opened.coinPublicKey, restored);
        setRecord(restored);
      }
    }).finally(() => {
      opening.current = false;
    });
  }, [seed, endpoints, backend, wallet, run, setBusy, settleUnconfirmed]);

  // Follow the wallet. It reports changes far more often than a person can
  // read them, so the screen is refreshed on a timer from the latest state.
  useEffect(() => {
    if (!wallet) return;
    let latest: FacadeState | undefined;
    const subscription = wallet.state().subscribe({
      next: (state) => {
        latest = state;
      },
      error: (cause: unknown) => {
        diag('wallet: sync FAILED', describeError(cause));
        setError(`The wallet stopped syncing: ${explainError(cause)}`);
      },
    });
    const timer = setInterval(() => {
      if (latest) setView(wallet.view(latest));
    }, refreshMs);
    return () => {
      subscription.unsubscribe();
      clearInterval(timer);
    };
  }, [wallet, refreshMs]);

  // A saved contract that could not be read when the wallet opened (the
  // indexer did not answer): keep asking until the chain says yes or no.
  useEffect(() => {
    const address = stored?.info?.contractAddress;
    if (!wallet || token || missing || !address) return;
    let current = true;
    const timer = setInterval(() => {
      backend
        .readToken(wallet, address)
        .then((onChain) => {
          if (!current) return;
          if (onChain) setToken(onChain);
          else setMissing(address);
        })
        .catch(() => undefined);
    }, 5_000);
    return () => {
      current = false;
      clearInterval(timer);
    };
  }, [wallet, backend, token, missing, stored]);

  const createWallet = () => {
    const fresh = newSeed();
    saveSeed(fresh);
    markWalletAsNew();
    setSeed(fresh);
  };

  const restoreWallet = (seedHex: string) => {
    // A restored wallet may own coins already: it must read the history.
    walletIsNoLongerNew();
    saveSeed(seedHex);
    setSeed(seedHex);
  };

  const forgetWallet = () => {
    if (!window.confirm('Forget this wallet? Without its seed, anything it holds is gone for good.')) return;
    void (async () => {
      await wallet?.stop().catch(() => undefined);
      forgetSeed();
      walletIsNoLongerNew();
      await forgetWalletState().catch(() => undefined);
      window.location.reload();
    })();
  };

  const registerDust = () =>
    run(`Registering your ${NIGHT} to generate ${DUST}…`, async () => {
      if (!wallet) return;
      const txId = await wallet.registerDust();
      diag(`dust registration submitted: ${txId}`);
      setBusy(`Registered. ${DUST} will start to appear in a moment…`);
      await new Promise((resolve) => setTimeout(resolve, 20_000));
    });

  const deploy = (name: string, symbol: string, decimals: number) =>
    run('Deploy: starting…', async () => {
      if (!wallet || !account) return;
      const meta = { name, symbol, decimals };
      // Save the secrets BEFORE deploying. If the page closes mid-deploy, the
      // owner's nonce must not be lost with it.
      const secrets = { secretNonce: randomHex32(), instanceSalt: randomHex32() };
      saveToken(account, { meta, secrets });
      setStored({ meta, secrets });
      // Resolves only after the contract was read back from the chain.
      const info = await backend.deployToken(wallet, meta, secrets, (stage) => setBusy(stageText('Deploy', stage)));
      const next = { meta, secrets, info };
      saveToken(account, next);
      setStored(next);
      setToken(info);
      setMissing(null);
    });

  /** Use a contract that is already on the network, by its address. */
  const join = (address: string) =>
    run(`Looking for that contract on ${NETWORK.label}…`, async () => {
      if (!wallet || !account) return;
      const info = await backend.readToken(wallet, address);
      if (!info) throw new Error(`There is no contract at that address on ${NETWORK.label}.`);
      // Keep the minting secrets if this browser deployed that very contract.
      const secrets = stored?.info?.contractAddress === address ? stored.secrets : undefined;
      const next = { meta: { name: info.name, symbol: info.symbol, decimals: info.decimals }, secrets, info };
      saveToken(account, next);
      setStored(next);
      setToken(info);
      setMissing(null);
    });

  /** Drop the saved contract, so another can be deployed or joined. */
  const forget = () => {
    if (
      stored?.secrets &&
      token &&
      !window.confirm('This browser holds the only key that can mint this token. Forget the contract anyway?')
    ) {
      return;
    }
    if (account) saveToken(account, undefined);
    setStored(undefined);
    setToken(null);
    setMissing(null);
    setError(null);
  };

  const mint = (amount: bigint) =>
    run('Mint: starting…', async () => {
      if (!wallet || !token || !stored?.secrets) return;
      await backend.mint(wallet, token, stored.secrets, amount, (stage) => setBusy(stageText('Mint', stage)));
      setBusy('Minted. Waiting for the wallet to see the new coins…');
      await new Promise((resolve) => setTimeout(resolve, 8_000));
    });

  const remember = useCallback(
    (next: PayoutRecord | undefined) => {
      if (account) savePayoutRecord(account, next);
      setRecord(next);
    },
    [account],
  );

  /**
   * Pay every line of `payments` that `start` does not already count as paid.
   *
   * Up to 64 lines go in one transaction; more are cut into transactions of 64
   * that are sent one after another. Each spends the change of the one before,
   * so the next can only be built once the previous has finalized and its
   * change has come back.
   *
   * What happens to each transaction is written to the record as it happens:
   *   - it could not be built (a proof failed, a request was dropped): nothing
   *     was submitted, so it is built again, up to BUILD_ATTEMPTS times;
   *   - it was built: it is never built a second time. The network's verdict
   *     decides: finalized (paid), failed (not paid), or no word (unconfirmed,
   *     and its lines are held back from sending again).
   * The run stops at the first transaction that was not paid, and whatever
   * was not reached stays "not sent", ready for the next press of the button.
   */
  const payList = (payments: readonly Payment[], start: PayoutRecord) => {
    const targets = unpaidLines(start);
    const batches = inBatches(targets.map((line) => ({ line, payment: payments[line - 1]! })));
    const many = batches.length > 1;
    const proving = (count: number) => `selecting coins and proving ${count} outputs on the proof server…`;
    return run(
      many ? `Paying ${targets.length} wallets in ${batches.length} transactions…` : `Payout: ${proving(targets.length)}`,
      async () => {
        if (!wallet || !token) return;
        stopRequested.current = false;
        setStopping(false);
        const startedAt = Date.now();
        const seconds = () => Math.round((Date.now() - startedAt) / 1000);
        let current: PayoutRecord = {
          ...start,
          run: { startedAt: new Date(startedAt).toISOString(), wallets: targets.length, transactions: batches.length },
        };
        remember(current);
        let stopped: string | undefined;
        let paid = 0;
        try {
          for (const [index, batch] of batches.entries()) {
            const label = many ? `Transaction ${index + 1} of ${batches.length}` : 'Payout';
            const lines = batch.map((entry) => entry.line);
            const batchPayments = batch.map((entry) => entry.payment);
            if (index > 0) {
              setBusy(`${label}: waiting for the change from the previous transaction…`);
              await wallet.waitForSpendable(token.tokenType, totalOf(batchPayments), CHANGE_WAIT_MS);
              setBusy(`${label}: ${proving(batch.length)}`);
            }

            // This transaction's place in the record. Every attempt to build it writes there.
            const slot = current.transactions.length;
            let tx: PayoutTx = { lines, at: new Date().toISOString(), outcome: 'sending' };
            let began = Date.now();
            let submitError: unknown;
            for (let attempt = 1; ; attempt++) {
              began = Date.now();
              tx = { lines, at: new Date(began).toISOString(), outcome: 'sending' };
              current = withTx(current, slot, tx);
              remember(current);
              try {
                await sendFanout(wallet, token.tokenType, batchPayments, (ref) => {
                  tx = { ...tx, txId: ref.txId, txHash: ref.txHash, bytes: ref.bytes, buildMs: Date.now() - began };
                  // Written down before it is submitted, so a reload cannot lose track of it.
                  current = withTx(current, slot, tx);
                  remember(current);
                  diag(
                    `payout: built in ${Math.round((Date.now() - began) / 1000)} s, ${ref.bytes} bytes for ${batch.length} recipients`,
                  );
                  setBusy(`${label}: submitting to the node…`);
                });
                break;
              } catch (cause) {
                if (tx.txId) {
                  // It was built, so it may have reached the node. Let the network say.
                  submitError = cause;
                  break;
                }
                tx = { ...tx, outcome: 'failed', note: `It could not be built: ${explainError(cause)}` };
                current = withTx(current, slot, tx);
                remember(current);
                diag(
                  `${label}: could not be built (${explainError(cause)}); attempt ${attempt} of ${BUILD_ATTEMPTS}`,
                  describeError(cause),
                );
                if (attempt >= BUILD_ATTEMPTS) throw cause;
                setBusy(`${label}: building it failed (${explainError(cause)}). Trying again…`);
                await new Promise((resolve) => setTimeout(resolve, 10_000));
                await wallet.waitForSpendable(token.tokenType, totalOf(batchPayments), CHANGE_WAIT_MS);
                setBusy(`${label}: ${proving(batch.length)}`);
              }
            }

            setBusy(`${label}: submitted. Waiting for the network to finalize it…`);
            const builtAt = began + (tx.buildMs ?? 0);
            const verdict = await backend.checkTx(wallet, tx.txId!, submitError ? 60_000 : FINALIZATION_WAIT_MS);
            tx = {
              ...tx,
              finalizeMs: Date.now() - builtAt,
              ...(verdict === 'finalized'
                ? { outcome: 'paid' }
                : verdict === 'failed'
                  ? { outcome: 'failed', note: 'This transaction failed on chain. Nothing in it was paid.' }
                  : {
                      outcome: 'unconfirmed',
                      note: submitError
                        ? `Submitting it failed (${explainError(submitError)}) and the network has not reported it.`
                        : 'The network did not report this transaction within five minutes.',
                    }),
            };
            current = withTx(current, slot, tx);
            remember(current);
            diag(`payout: ${batch.length} recipients, ${tx.bytes ?? '?'} bytes, outcome ${tx.outcome}`);
            if (tx.outcome !== 'paid') {
              stopped =
                tx.outcome === 'failed'
                  ? `Transaction ${index + 1} failed on chain, so nothing in it was paid.`
                  : `The network has not reported transaction ${index + 1}. Its lines are held back until it has.`;
              break;
            }
            paid += batch.length;
            diag(
              `run: transaction ${index + 1} of ${batches.length} finalized, ${paid} of ${targets.length} wallets paid, ${seconds()} s so far`,
            );
            if (stopRequested.current && index < batches.length - 1) {
              stopped = 'Stopped at your request.';
              break;
            }
          }
        } catch (cause) {
          stopped = explainError(cause);
          throw cause;
        } finally {
          current = { ...current, run: { ...current.run!, endedAt: new Date().toISOString(), stopped } };
          remember(current);
          diag(
            `run: ended, ${paid} of ${targets.length} wallets paid, ${seconds()} s in total${stopped ? `, stopped: ${stopped}` : ''}`,
          );
          setStopping(false);
        }
      },
    );
  };

  /** The list was entered: start a record for it, or pick up the one it belongs to, and pay. */
  const startList = (payments: Payment[], fingerprint: string, resume: boolean) => {
    const start: PayoutRecord =
      resume && record ? record : { fingerprint, lineCount: payments.length, transactions: [] };
    setList(payments);
    setListOpen(true);
    setAnother(false);
    remember(start);
    if (unpaidLines(start).length > 0) void payList(payments, start);
  };

  /** Back to the payout in progress, with its list loaded again. Nothing is sent until the user asks. */
  const reopenList = (payments?: Payment[]) => {
    if (payments) setList(payments);
    setListOpen(true);
    setAnother(false);
  };

  const sendUnpaid = () => {
    if (list && record) void payList(list, record);
  };

  const checkUnconfirmed = () =>
    run('Asking the network about the unconfirmed transactions…', async () => {
      if (wallet && record) remember(await settleUnconfirmed(wallet, record, 15_000));
    });

  /**
   * Leave the list. While any of it is unpaid, its record is kept and the list
   * stays in memory, so the payout can be opened again and continued.
   */
  const closeList = () => {
    setListOpen(false);
    if (record && lineStates(record, false).every((state) => state.status === 'paid')) {
      setList(null);
      remember(undefined);
    }
  };

  const discardRecord = () => {
    if (!window.confirm('Forget this payout? This page will no longer know which lines of its list were paid.')) return;
    setList(null);
    setListOpen(false);
    remember(undefined);
  };

  // True while this page is working through a payout.
  const running = !!busy && !!record?.run && !record.run.endedAt && !record.run.stopped;
  // Closing or reloading the page cuts a run short, so the browser asks first.
  useEffect(() => {
    if (!running) return;
    const ask = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener('beforeunload', ask);
    return () => window.removeEventListener('beforeunload', ask);
  }, [running]);
  // NIGHT the wallet holds, counting what is tied up in a transaction: registering for DUST
  // spends the NIGHT and returns it, and for those few blocks the spendable balance reads zero.
  const night = (view?.night ?? 0n) + (view?.nightPending ?? 0n);
  const nightBusy = (view?.nightPending ?? 0n) > 0n;
  const noTokenYet =
    stored?.info && !missing ? `Reading your saved contract from ${NETWORK.label}…` : 'Deploy or join a contract first.';
  const walletLocked = !wallet ? 'Create or restore a wallet first.' : !synced && 'The wallet is still syncing.';
  const tokenLocked = walletLocked || (!token ? noTokenYet : !hasDust && `You need ${DUST} first.`);

  // The six steps. One is on screen at a time; the tabs show how far along each is.
  const steps: StepInfo[] = [
    { number: 1, tab: 'Wallet', title: 'Your wallet', done: !!wallet && synced, locked: false },
    { number: 2, tab: NIGHT, title: NETWORK.faucet ? `Get ${NIGHT} from the faucet` : `Fund the wallet with ${NIGHT}`, done: night > 0n, locked: !wallet && 'Create or restore a wallet first.' },
    { number: 3, tab: DUST, title: `Generate ${DUST}`, done: hasDust, locked: walletLocked || (night === 0n && `Get ${NIGHT} first.`) },
    { number: 4, tab: 'Token', title: 'Your token contract', done: !!token, locked: walletLocked },
    { number: 5, tab: 'Mint', title: 'Mint', done: !!token && (balance > 0n || arriving > 0n), locked: tokenLocked },
    // A payout, loaded or waiting for its list, stays on screen whatever the balances do: its progress must never be hidden.
    { number: 6, tab: 'Pay', title: 'Pay wallets', done: false, locked: (list || record) && token ? false : tokenLocked },
  ];
  // Until the user picks a tab, show the first step that still needs doing.
  // It only ever moves forward: a balance that dips while a transaction is in flight must not
  // send the page back to a step that was already done.
  const nextStep = list || running ? 6 : (steps.find((step) => !step.done)?.number ?? 6);
  furthestStep.current = Math.max(furthestStep.current, nextStep);
  const suggested = furthestStep.current;
  const shown = picked ?? suggested;
  // Once the flow has reached the payout, stay there: a balance that reads
  // zero for a moment mid-payout must not flip the screen to another step.
  useEffect(() => {
    if (picked === null && suggested === 6) setPicked(6);
  }, [picked, suggested]);
  const syncPercent = view
    ? Math.floor(Math.min(view.progress.shielded, view.progress.dust, view.progress.unshielded) * 100)
    : 0;

  return (
    <main className="app">
      {/* The information panel: always on screen, whatever step is open. */}
      <aside className="info" aria-label="Status">
        <header className="brand">
          <img className="logo" src={logo} alt="Midnight" />
          <div className="product">
            <h1>Shielded fanout</h1>
            <span className="pill">Proof of concept</span>
          </div>
          <p>Mint a shielded token, then pay many wallets in one transaction.</p>
          <NetworkSwitch disabled={!!busy} />
        </header>

        <div className="now">
          {busy ? (
            <p className="status" role="status">
              {busy} <Elapsed since={busySince} />
            </p>
          ) : (
            <p className="status idle" role="status">
              Nothing in progress.
            </p>
          )}
          {error && (
            <p className="error" role="alert">
              {error}{' '}
              <button type="button" className="link" onClick={() => setError(null)}>
                Dismiss
              </button>
            </p>
          )}
          {NETWORK.realFunds && (
            <p className="notice" role="note">
              <strong>Mainnet: real funds.</strong> This is a proof of concept. It keeps the wallet's seed unencrypted
              in this browser. Use amounts you can afford to lose.
            </p>
          )}
          {proofServerUp === false && (
            <p className="error" role="alert">
              No proof server is answering at {proofServer}. The Wallet step says how to start one.
            </p>
          )}
        </div>

        <dl className="facts">
          <dt>Wallet</dt>
          <dd data-testid="info-wallet">
            {!seed ? 'None yet' : !wallet ? 'Opening…' : synced ? 'Up to date' : view ? `Syncing, ${syncPercent}%` : 'Starting…'}
          </dd>
          <dt>{NIGHT}</dt>
          <dd>
            {view ? formatAmount(night, NIGHT_DECIMALS) : '—'}
            {nightBusy && <span className="hint"> in a transaction</span>}
          </dd>
          <dt>{DUST}</dt>
          <dd>
            {view ? formatDust(dust) : '—'}
            {dustBusy && <span className="hint"> in a transaction</span>}
          </dd>
          {token && (
            <>
              <dt>{token.symbol}</dt>
              <dd data-testid="info-balance">
                {formatAmount(balance, token.decimals)}
                {arriving > 0n && <span className="hint"> + {formatAmount(arriving, token.decimals)} returning</span>}
              </dd>
            </>
          )}
          <dt>Proof server</dt>
          <dd className={proofServerUp === false ? 'failed' : undefined}>
            {proofServerUp === null ? 'Checking…' : proofServerUp ? 'Answering' : 'Not answering'}
          </dd>
        </dl>

        {record && (
          <>
            <h2>Payout list</h2>
            <PayoutCounts record={record} running={running} />
            {/* From any other step, one press leads back to the payout. */}
            {shown !== 6 && (
              <button type="button" className="secondary to-payout" onClick={() => setPicked(6)} data-testid="to-payout">
                {running ? 'Watch the payout' : 'Go to the payout'}
              </button>
            )}
          </>
        )}

        <h2>Activity</h2>
        <ol className="activity">
          {activity.length === 0 && <li className="hint">Every step the page takes is listed here.</li>}
          {[...activity].reverse().map((line, index) => (
            <li key={`${line.time}-${index}`} className={line.failed ? 'failed' : undefined}>
              <span className="time">{line.time}</span> {line.text}
            </li>
          ))}
        </ol>
      </aside>

      <section className="work">
        <nav className="tabs" role="tablist" aria-label="Steps">
          {steps.map((step) => (
            <button
              key={step.number}
              type="button"
              role="tab"
              aria-selected={shown === step.number}
              className={`tab${step.done ? ' done' : ''}${step.locked ? ' locked' : ''}`}
              onClick={() => setPicked(step.number)}
            >
              <span className="number">{step.done ? '✓' : step.number}</span> {step.tab}
            </button>
          ))}
        </nav>
        <div className="panel">
          <Step step={steps[0]!} shown={shown}>
            {!seed ? (
              <NewWallet disabled={!!busy} onCreate={createWallet} onRestore={restoreWallet} />
            ) : (
              <>
                {wallet ? (
                  <dl>
                    <dt>Network</dt>
                    <dd>{NETWORK.label}</dd>
                    <dt>Shielded address</dt>
                    <dd className="mono">{wallet.shieldedAddress}</dd>
                    <dt>Sync</dt>
                    <dd>
                      {view ? (
                        synced ? (
                          'Up to date with the chain.'
                        ) : (
                          <SyncProgress view={view} />
                        )
                      ) : (
                        'Starting…'
                      )}
                    </dd>
                  </dl>
                ) : (
                  <p className="hint">Opening the wallet…</p>
                )}
                <SeedBox seed={seed} />
                <button className="secondary" onClick={forgetWallet}>
                  Forget this wallet
                </button>
              </>
            )}
            <ProofServerSetting proofServer={proofServer} up={proofServerUp} />
          </Step>

          <Step step={steps[1]!} shown={shown}>
            {wallet && (
              <>
                <p>
                  {NETWORK.faucet
                    ? `${NIGHT} is ${NETWORK.label}'s test token. Open the faucet, paste this address, and request tokens. This site cannot do it for you.`
                    : `Send ${NIGHT} to this address from an exchange or another wallet. The ${DUST} it generates pays the fees.`}
                </p>
                <dl>
                  <dt>Send {NIGHT} to</dt>
                  <dd className="mono">{wallet.unshieldedAddress}</dd>
                  <dt>{NIGHT} in this wallet</dt>
                  <dd data-testid="night">
                    {view ? formatAmount(night, NIGHT_DECIMALS) : '…'}
                    {nightBusy && <span className="hint"> (tied up in a transaction for a few blocks)</span>}
                  </dd>
                </dl>
                <div className="row-actions">
                  {NETWORK.faucet && (
                    <a className="button" href={NETWORK.faucet} target="_blank" rel="noreferrer">
                      Open the {NETWORK.label} faucet
                    </a>
                  )}
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => void navigator.clipboard?.writeText(wallet.unshieldedAddress)}
                  >
                    Copy the address
                  </button>
                </div>
                {!synced && <p className="hint">The balance appears once the wallet has caught up with the chain.</p>}
              </>
            )}
          </Step>

          <Step step={steps[2]!} shown={shown}>
            {wallet && view && (
              <>
                <p>
                  Fees are paid in {DUST}. {DUST} is not bought or sent: your {NIGHT} generates it over time, once you
                  register that {NIGHT}. Registering is one transaction and pays for itself.
                </p>
                <dl>
                  <dt>{DUST} available</dt>
                  <dd data-testid="dust">{formatDust(dust)}</dd>
                  <dt>{NIGHT} registered</dt>
                  <dd>
                    {view.dustRegistered
                      ? `Yes. It is generating ${DUST}.`
                      : nightBusy
                        ? 'Being registered now. This takes a few blocks.'
                        : `No. ${view.unregisteredNightCoins} ${NIGHT} coin(s) waiting to be registered.`}
                  </dd>
                </dl>
                {view.unregisteredNightCoins > 0 && (
                  <button disabled={!!busy} onClick={registerDust}>
                    Generate {DUST}
                  </button>
                )}
                {view.dustRegistered && dust < DEPLOY_COST_DUST && <DustWait dust={dust} needed={DEPLOY_COST_DUST} />}
              </>
            )}
          </Step>

          <Step step={steps[3]!} shown={shown}>
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
                  <dt>On {NETWORK.label}</dt>
                  <dd>Yes. Read back from the chain.</dd>
                </dl>
                <p className="hint">
                  {stored?.secrets
                    ? "This browser deployed it and holds the owner's secret, so only this browser can mint. Clearing site data loses that for good."
                    : 'You joined this contract. Only the wallet that deployed it can mint.'}
                </p>
                <button className="secondary" disabled={!!busy} onClick={forget}>
                  Use a different contract
                </button>
              </>
            ) : missing ? (
              <div className="notice">
                <p>
                  This browser saved a contract address, but <strong>no such contract exists on {NETWORK.label}</strong>. It was
                  never deployed.
                </p>
                <p className="mono">{missing}</p>
                <button disabled={!!busy} onClick={forget}>
                  Forget it and start again
                </button>
              </div>
            ) : (
              <>
                <p>No contract yet. Deploy a new one, or use one that is already on {NETWORK.label}.</p>
                {dust < DEPLOY_COST_DUST && <DustWait dust={dust} needed={DEPLOY_COST_DUST} />}
                <DeployForm disabled={!!busy || dust < DEPLOY_COST_DUST} onDeploy={deploy} />
                <JoinForm disabled={!!busy} onJoin={join} />
              </>
            )}
          </Step>

          <Step step={steps[4]!} shown={shown}>
            {token && (
              <>
                <BalanceLine token={token} balance={balance} arriving={arriving} />
                {canMint ? (
                  <MintForm token={token} disabled={!!busy} onMint={mint} />
                ) : (
                  <p className="hint">Only the wallet that deployed this contract can mint it.</p>
                )}
              </>
            )}
          </Step>

          <Step step={steps[5]!} shown={shown}>
            {token &&
              (list && record && listOpen ? (
                <PayoutBoard
                  token={token}
                  payments={list}
                  record={record}
                  running={running}
                  stopping={stopping}
                  busy={!!busy}
                  balance={balance}
                  onStop={() => {
                    stopRequested.current = true;
                    setStopping(true);
                  }}
                  onSendUnpaid={sendUnpaid}
                  onCheck={checkUnconfirmed}
                  onNew={closeList}
                  fetchTx={(txHash) => backend.txRaw(txHash)}
                />
              ) : record && !another ? (
                <PayoutResume
                  token={token}
                  record={record}
                  inMemory={!!list}
                  busy={!!busy}
                  onReopen={() => reopenList()}
                  onOpen={reopenList}
                  onCheck={checkUnconfirmed}
                  onAnother={() => setAnother(true)}
                  onForget={discardRecord}
                />
              ) : (
                <PayoutInput
                  token={token}
                  balance={balance}
                  arriving={arriving}
                  disabled={!!busy}
                  record={record}
                  onStart={startList}
                  onBack={() => setAnother(false)}
                />
              ))}
          </Step>
        </div>
      </section>
    </main>
  );
}

function NewWallet(props: { disabled: boolean; onCreate: () => void; onRestore: (seed: string) => void }) {
  const [text, setText] = useState('');
  const cleaned = text.trim().toLowerCase();
  const valid = /^[0-9a-f]{64}$/.test(cleaned);
  return (
    <>
      <p>
        The wallet lives in this page. It is the Midnight wallet SDK, the same code a backend service would run, with
        its seed kept in this browser.
      </p>
      <button disabled={props.disabled} onClick={props.onCreate}>
        Create a new wallet
      </button>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (valid) props.onRestore(cleaned);
        }}
      >
        <div className="fields">
          <label>
            Or restore one from its seed
            <input
              className="mono"
              type="password"
              value={text}
              placeholder="64 hex characters"
              spellCheck={false}
              autoComplete="off"
              onChange={(event) => setText(event.target.value)}
            />
          </label>
        </div>
        {text !== '' && !valid && <p className="field-error">A seed is 64 hex characters.</p>}
        <button type="submit" className="secondary" disabled={props.disabled || !valid}>
          Restore wallet
        </button>
      </form>
    </>
  );
}

/** The seed, hidden until asked for. */
function SeedBox({ seed }: { seed: string }) {
  const [shown, setShown] = useState(false);
  return (
    <div className="notice">
      <p>
        <strong>Back up the seed.</strong> It is the wallet. It is stored unencrypted in this browser, which is fine
        for a test wallet and not for funds you cannot afford to lose.
      </p>
      {shown && <p className="mono">{seed}</p>}
      <div className="row-actions">
        <button type="button" className="secondary" onClick={() => setShown(!shown)}>
          {shown ? 'Hide the seed' : 'Show the seed'}
        </button>
        <button type="button" className="secondary" onClick={() => void navigator.clipboard?.writeText(seed)}>
          Copy the seed
        </button>
      </div>
    </div>
  );
}

/** How far each part of the wallet has caught up with the chain. */
function SyncProgress({ view }: { view: WalletView }) {
  const parts: Array<[string, number]> = [
    ['Shielded coins', view.progress.shielded],
    [DUST, view.progress.dust],
    [NIGHT, view.progress.unshielded],
  ];
  return (
    <div className="sync">
      {parts.map(([name, value]) => (
        <label key={name}>
          {name}: {value >= 1 ? 'done' : value <= 0 ? 'checking…' : `${(value * 100).toFixed(1)}%`}
          {value <= 0 ? <progress /> : <progress value={value} max={1} />}
        </label>
      ))}
      <p className="hint">
        A wallet restored from a seed reads the chain's history once, which takes several minutes (about six on
        Preprod). Progress is saved in this browser, so later visits take seconds. Keep this tab in front while it
        runs. A wallet created here skips this: it has no history to read.
      </p>
    </div>
  );
}

/**
 * Deploying needs more DUST than a freshly registered wallet has. This says how
 * much is missing and, from how fast the balance has been growing while the
 * page watched, about how long that will take.
 */
function DustWait({ dust, needed }: { dust: bigint; needed: bigint }) {
  const first = useRef({ at: Date.now(), dust });
  const seconds = (Date.now() - first.current.at) / 1000;
  const gained = dust - first.current.dust;
  // DUST per second, once there is enough of a stretch to judge by.
  const rate = seconds >= 5 && gained > 0n ? Number(gained) / seconds : 0;
  const minutes = rate > 0 ? Math.ceil(Number(needed - dust) / rate / 60) : null;
  return (
    <p className="hint" data-testid="dust-wait">
      Deploying the token costs about {formatDust(needed)} {DUST} and this wallet has {formatDust(dust)}.{' '}
      {dust === 0n
        ? `Register your ${NIGHT} in step 3 first.`
        : minutes === null
          ? 'It grows with every block.'
          : `It grows with every block: about ${minutes} more ${minutes === 1 ? 'minute' : 'minutes'}.`}
    </p>
  );
}

/** The network the page is on, and the way to another. Each network has its own wallet and token. */
function NetworkSwitch({ disabled }: { disabled: boolean }) {
  const choose = (id: NetworkId) => {
    if (id === NETWORK.id) return;
    const target = NETWORKS[id];
    if (
      target.realFunds &&
      !window.confirm(
        `${target.label} uses real NIGHT. This proof of concept keeps the wallet's seed unencrypted in this browser. Switch to ${target.label}?`,
      )
    ) {
      return;
    }
    switchNetwork(id);
  };
  return (
    <div className="network" role="radiogroup" aria-label="Network">
      {Object.values(NETWORKS).map((network) => (
        <button
          key={network.id}
          type="button"
          role="radio"
          aria-checked={network.id === NETWORK.id}
          disabled={disabled && network.id !== NETWORK.id}
          title={disabled ? 'Wait for the current step to finish before switching.' : undefined}
          onClick={() => choose(network.id)}
        >
          {network.label}
        </button>
      ))}
    </div>
  );
}

/** True when the page itself is served from this machine, as with `pnpm dev`. */
const LOCAL_PAGE = ['localhost', '127.0.0.1', '[::1]'].includes(window.location.hostname);

/** The command that starts a proof server on the visitor's own machine. */
const PROOF_SERVER_COMMAND =
  'docker run --rm -p 127.0.0.1:6300:6300 midnightntwrk/proof-server:9.0.2 midnight-proof-server --job-capacity 1024';

/**
 * Every transaction needs zero-knowledge proofs, and whoever makes them sees
 * the transaction's private inputs. So the proof server is the user's own: this
 * says how to start one and where the page should look for it.
 */
function ProofServerSetting(props: { proofServer: string; up: boolean | null }) {
  const [value, setValue] = useState(props.proofServer);
  const save = (event: FormEvent) => {
    event.preventDefault();
    if (value.trim()) localStorage.setItem(PROOF_SERVER_KEY, value.trim());
    else localStorage.removeItem(PROOF_SERVER_KEY);
    window.location.reload();
  };
  return (
    <details className="connections" open={props.up === false ? true : undefined}>
      <summary>
        Proof server: {props.up === null ? 'checking…' : props.up ? 'answering' : 'not answering'}
      </summary>
      <p className="hint">
        Proofs are made on your own machine, because a proof server sees a transaction's private inputs. Start one
        with Docker, and leave it running:
      </p>
      <p className="mono command">{PROOF_SERVER_COMMAND}</p>
      <div className="row-actions">
        <button type="button" className="secondary" onClick={() => void navigator.clipboard?.writeText(PROOF_SERVER_COMMAND)}>
          Copy the command
        </button>
      </div>
      {props.up === false && !LOCAL_PAGE && (
        <p className="hint">
          <strong>Running, but still not answering?</strong> This page is on the internet and the proof server is on
          your computer, and browsers ask before letting a site reach your computer. In Chrome, choose Allow when it
          asks to connect to devices on your local network, or allow it from the padlock menu in the address bar. In
          Brave, allow this site under Settings, Privacy and security, Site and Shields settings, Localhost access.
          Safari does not allow it: use Chrome, or run the app on your own machine.
        </p>
      )}
      <form onSubmit={save}>
        <label>
          Where it listens
          <input className="mono" value={value} spellCheck={false} autoComplete="off" onChange={(event) => setValue(event.target.value)} />
        </label>
        <button type="submit" className="secondary" disabled={value.trim() === props.proofServer}>
          Save and reload
        </button>
      </form>
    </details>
  );
}

/** One of the six steps: what its tab says, and whether it is done or not yet possible. */
interface StepInfo {
  readonly number: number;
  readonly tab: string;
  readonly title: string;
  readonly done: boolean;
  /** Why the step cannot be done yet, or false when it can. */
  readonly locked: string | false;
}

/** The content of one step. Only the step that is on screen renders anything. */
function Step(props: { step: StepInfo; shown: number; children: ReactNode }) {
  const { step } = props;
  if (step.number !== props.shown) return null;
  return (
    <section className="step" aria-labelledby={`step-${step.number}`}>
      <h2 id={`step-${step.number}`}>
        <span className="number">{step.done ? '✓' : step.number}</span> {step.title}
      </h2>
      {step.locked ? <p className="hint">{step.locked}</p> : props.children}
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

function JoinForm(props: { disabled: boolean; onJoin: (address: string) => void }) {
  const [address, setAddress] = useState('');
  const cleaned = address.trim().toLowerCase();
  const valid = /^[0-9a-f]{64}$/.test(cleaned);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (valid) props.onJoin(cleaned);
  };

  return (
    <form onSubmit={submit}>
      <div className="fields">
        <label>
          Address of a contract already on {NETWORK.label}
          <input
            className="mono"
            value={address}
            placeholder="64 hex characters"
            spellCheck={false}
            autoComplete="off"
            onChange={(event) => setAddress(event.target.value)}
          />
        </label>
      </div>
      {address !== '' && !valid && <p className="field-error">A contract address is 64 hex characters.</p>}
      <button type="submit" className="secondary" disabled={props.disabled || !valid}>
        Use this contract
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
