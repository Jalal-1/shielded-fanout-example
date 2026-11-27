// The wallet this app uses: a Midnight wallet living in the page.
//
// It wraps the SDK wallet from ./sdk-wallet.ts with the few operations the
// app needs, each one a short sequence of wallet SDK calls:
//
//   registerDust()        turn the wallet's NIGHT into a source of DUST (fees)
//   balanceAndSign(tx)    add the fee to a contract transaction, sign, seal
//   transfer(payments)    pay any number of shielded recipients in ONE transaction
//   submit(tx)            hand a finished transaction to the node
//
// A backend service would use the wallet SDK in exactly this way. Only the
// storage differs: here the seed and the sync state live in the browser.
import {
  Transaction,
  ZswapSecretKeys,
  unshieldedToken,
  type FinalizedTransaction,
} from '@midnight-ntwrk/midnight-js-protocol/v9';
import {
  DefaultForkSchedule,
  DustAddress,
  MidnightBech32m,
  ProtocolVersion,
  ShieldedAddress,
  ShieldedCoinPublicKey,
  ShieldedEncryptionPublicKey,
  WalletTransaction,
  type FacadeState,
} from 'fanout-wallet-sdk';
import { filter, firstValueFrom, timeout, type Observable } from 'rxjs';
import { diag } from '../diag';
import { DUST } from '../network';
import { buildSdkWallet, type Endpoints, type SavedWalletState, type SdkWallet } from './sdk-wallet';
import { loadWalletState, saveWalletState, walletIsNew, walletIsNoLongerNew } from './wallet-store';

/** One shielded payment: who, and how much in the token's smallest unit. */
export interface ShieldedPayment {
  readonly recipient: string;
  readonly amount: bigint;
}

/** What the UI shows about the wallet at one moment. */
export interface WalletView {
  readonly synced: boolean;
  /** How far each part of the wallet has caught up with the chain, 0 to 1. */
  readonly progress: { readonly shielded: number; readonly dust: number; readonly unshielded: number };
  /** Unshielded NIGHT that can be spent now, in its smallest unit (6 decimals). */
  readonly night: bigint;
  /**
   * NIGHT tied up in a transaction that has not finalized yet. Registering for
   * DUST spends the wallet's NIGHT and returns it, so for a few blocks all of
   * it is here and `night` reads zero.
   */
  readonly nightPending: bigint;
  /** DUST available right now, in its smallest unit (15 decimals). */
  readonly dust: bigint;
  /**
   * True while DUST is tied up in a transaction that has not finalized yet. A
   * fee spends a whole DUST coin and returns the rest, so a wallet with one
   * coin reads zero DUST for those few blocks.
   */
  readonly dustBusy: boolean;
  /** True once the wallet's NIGHT has been registered to generate DUST. */
  readonly dustRegistered: boolean;
  /** NIGHT coins not yet registered for DUST. */
  readonly unregisteredNightCoins: number;
  /** Shielded balances by token type (hex): coins that can be spent now. */
  readonly shielded: Readonly<Record<string, bigint>>;
  /** Shielded coins on their way to this wallet (change of a transaction not yet finalized), by token type. */
  readonly shieldedArriving: Readonly<Record<string, bigint>>;
}

/** How long a transaction built now stays valid. */
export const TTL_MS = 30 * 60_000;
const ttl = (): Date => new Date(Date.now() + TTL_MS);

/** How far along one sub-wallet's sync is, from its progress counters. */
function fraction(progress: unknown): number {
  const p = progress as {
    appliedIndex?: bigint;
    highestRelevantWalletIndex?: bigint;
    appliedId?: bigint;
    highestTransactionId?: bigint;
    isStrictlyComplete?: () => boolean;
  };
  try {
    if (p.isStrictlyComplete?.()) return 1;
  } catch {
    // Fall through to the counters.
  }
  const done = p.appliedIndex ?? p.appliedId ?? 0n;
  const target = p.highestRelevantWalletIndex ?? p.highestTransactionId ?? 0n;
  if (target <= 0n) return 0;
  return Math.min(0.999, Number(done) / Number(target));
}

export class BrowserWallet {
  /** The wallet's shielded address: coins sent here land in this wallet. */
  readonly shieldedAddress: string;
  /** Where NIGHT is sent to: the faucet's target on a test network. */
  readonly unshieldedAddress: string;
  /** The keys Midnight.js needs to build contract calls for this wallet (hex). */
  readonly coinPublicKey: string;
  readonly encryptionPublicKey: string;

  private saveTimer: ReturnType<typeof setInterval> | undefined;

  private constructor(
    private readonly sdk: SdkWallet,
    private readonly endpoints: Endpoints,
    private readonly stateKey: string,
  ) {
    const keys = ZswapSecretKeys.fromSeed(sdk.seeds.shielded);
    this.coinPublicKey = keys.coinPublicKey;
    this.encryptionPublicKey = keys.encryptionPublicKey;
    this.shieldedAddress = MidnightBech32m.encode(
      endpoints.networkId,
      new ShieldedAddress(
        ShieldedCoinPublicKey.fromHexString(keys.coinPublicKey),
        ShieldedEncryptionPublicKey.fromHexString(keys.encryptionPublicKey),
      ),
    ).asString();
    this.unshieldedAddress = String(sdk.keystore.getBech32Address());
  }

  /**
   * Open the wallet for `seedHex`: resume from the state saved in this browser
   * if there is any, otherwise start from nothing, then begin syncing.
   */
  static async open(seedHex: string, endpoints: Endpoints, note: (step: string) => void): Promise<BrowserWallet> {
    // The leading number is the saved state's layout: raise it to make every browser start afresh.
    const stateKey = await fingerprint(`2:${endpoints.networkId}:${seedHex}`);
    const saved = await loadWalletState(stateKey).catch(() => undefined);
    // A wallet created a moment ago has no history, and need not read the chain's.
    const brandNew = !saved && walletIsNew();
    const sdk = await buildSdkWallet(seedHex, endpoints, note, saved, brandNew);
    const wallet = new BrowserWallet(sdk, endpoints, stateKey);
    note('starting to sync with the chain');
    await sdk.facade.start(sdk.seeds);
    if (brandNew) {
      // Saved at once: from here on the wallet has a state of its own to resume
      // from, and is never again treated as having no history.
      await wallet.save();
      walletIsNoLongerNew();
    }
    // Save progress regularly, so a reload continues where this left off.
    wallet.saveTimer = setInterval(() => void wallet.save(), 60_000);
    return wallet;
  }

  /** Every change of the wallet's state. */
  state(): Observable<FacadeState> {
    return this.sdk.facade.state();
  }

  /** The numbers the UI shows, from one wallet state. */
  view(state: FacadeState): WalletView {
    const night = unshieldedToken().raw;
    const nightCoins = state.unshielded.availableCoins.filter((coin) => coin.utxo.type === night);
    const unregistered = nightCoins.filter((coin) => !coin.meta.registeredForDustGeneration).length;
    return {
      synced: state.isSynced,
      progress: {
        shielded: fraction(state.shielded.progress),
        dust: fraction(state.dust.progress),
        unshielded: fraction(state.unshielded.progress),
      },
      night: state.unshielded.balances[night] ?? 0n,
      nightPending: state.unshielded.pendingCoins
        .filter((coin) => coin.utxo.type === night)
        .reduce((sum, coin) => sum + coin.utxo.value, 0n),
      dust: state.dust.balance(new Date()),
      dustBusy: state.dust.pendingCoins.length > 0,
      dustRegistered: nightCoins.length > 0 && unregistered === 0,
      unregisteredNightCoins: unregistered,
      shielded: state.shielded.balances,
      shieldedArriving: state.shielded.pendingCoins.reduce<Record<string, bigint>>((sums, { coin }) => {
        sums[coin.type] = (sums[coin.type] ?? 0n) + coin.value;
        return sums;
      }, {}),
    };
  }

  /** Save the sync state in this browser. */
  async save(): Promise<void> {
    try {
      const state: SavedWalletState = await this.sdk.serialize();
      await saveWalletState(this.stateKey, state);
    } catch (error) {
      diag('wallet: could not save sync state', String(error));
    }
  }

  async stop(): Promise<void> {
    if (this.saveTimer) clearInterval(this.saveTimer);
    await this.save();
    await this.sdk.facade.stop();
  }

  /**
   * Register the wallet's NIGHT to generate DUST. Fees are paid in DUST, and
   * DUST only exists as something NIGHT generates over time once registered.
   * The registration pays its own fee out of the DUST that NIGHT has already
   * earned, so it needs nothing up front.
   */
  async registerDust(): Promise<string> {
    const { facade, keystore } = this.sdk;
    const state = await facade.waitForSyncedState();
    const night = unshieldedToken().raw;
    const unregistered = state.unshielded.availableCoins.filter(
      (coin) => coin.utxo.type === night && !coin.meta.registeredForDustGeneration,
    );
    if (unregistered.length === 0) throw new Error('There is no unregistered NIGHT in this wallet.');
    const recipe = await facade.registerNightUtxosForDustGeneration(unregistered, keystore.getPublicKey(), (payload) =>
      keystore.signDataAsync(payload),
    );
    const finalized = await facade.finalizeRecipe(recipe);
    return String(await facade.submitTransaction(finalized));
  }

  /**
   * Finish a contract transaction that Midnight.js built and proved: add the
   * DUST fee, sign with the wallet's keys and seal it.
   */
  async balanceAndSign(unbound: Transaction<never, never, never>): Promise<FinalizedTransaction> {
    const { facade } = this.sdk;
    const active = await this.activeProtocol();
    const recipe = await this.whenDustIsFree(() =>
      facade.balanceUnboundTransaction(WalletTransaction.adopt('Unbound', unbound as never, active), { ttl: ttl() }),
    );
    return this.finish(recipe);
  }

  /**
   * THE FANOUT. Pay every recipient in one transaction.
   *
   * `transferTransaction` selects the coins to spend, creates one shielded
   * output per recipient plus a change output back to this wallet, and adds
   * the DUST fee. Signing and proving follow, then submission. Either every
   * recipient is paid or none is.
   */
  async buildTransfer(tokenType: string, payments: readonly ShieldedPayment[]): Promise<FinalizedTransaction> {
    if (payments.length === 0) throw new Error('A payout needs at least one recipient.');
    const { networkId } = this.endpoints;
    const recipe = await this.whenDustIsFree(() =>
      this.sdk.facade.transferTransaction(
        [
          {
            type: 'shielded',
            outputs: payments.map((payment) => ({
              type: tokenType,
              receiverAddress: MidnightBech32m.parse(payment.recipient).decode(ShieldedAddress, networkId),
              amount: payment.amount,
            })),
          },
        ],
        { ttl: ttl(), payFees: true },
      ),
    );
    return this.finish(recipe);
  }

  /** Hand a finished transaction to the node. Returns its identifier. */
  async submit(tx: FinalizedTransaction): Promise<string> {
    const active = await this.activeProtocol();
    return String(await this.sdk.facade.submitTransaction(WalletTransaction.adopt('Finalized', tx, active)));
  }

  /**
   * Wait until the wallet can spend `amount` of a token.
   *
   * A payment spends whole coins and the rest comes back as change, which can
   * be spent only once the wallet has seen that transaction finalized. Between
   * two payouts in a row, this is the wait for the change of the first.
   */
  async waitForSpendable(tokenType: string, amount: bigint, maxWaitMs: number): Promise<void> {
    try {
      await firstValueFrom(
        this.sdk.facade.state().pipe(
          filter((state) => (state.shielded.balances[tokenType] ?? 0n) >= amount),
          timeout({ first: maxWaitMs }),
        ),
      );
    } catch {
      throw new Error(
        `The wallet still cannot spend that much after ${Math.round(maxWaitMs / 1000)} seconds: the change from the previous transaction has not come back.`,
      );
    }
  }

  /** The wallet's DUST address, for display. */
  async dustAddress(): Promise<string> {
    const state = await firstValueFrom(this.sdk.facade.state());
    return MidnightBech32m.encode(this.endpoints.networkId, state.dust.address as DustAddress).asString();
  }

  /**
   * Run a step that pays a fee, waiting if the wallet's DUST is still tied up.
   *
   * A fee spends one of the wallet's DUST coins and gets a new one back. Until
   * the previous transaction is finalized that coin cannot be spent, and the
   * SDK answers that its coin selection "declined the remaining dust coin(s)".
   * That clears by itself within a few blocks, so wait and try again.
   *
   * Not having enough DUST is a different answer ("could not balance dust")
   * and waiting a few blocks does not cure it: say so at once, with the amount
   * the wallet has.
   */
  private async whenDustIsFree<T>(step: () => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await step();
      } catch (error) {
        const text = String(error);
        if (/could not balance dust/i.test(text)) {
          const state = await firstValueFrom(this.sdk.facade.state());
          const have = Number(state.dust.balance(new Date()) / 10n ** 12n) / 1000;
          throw new Error(
            `Not enough ${DUST} for this transaction's fee: the wallet has ${have.toFixed(3)} right now. ${DUST} grows with every block, so wait a little and try again.`,
          );
        }
        const dustBusy = /declined the remaining/i.test(text) && /dust/i.test(text);
        if (!dustBusy || attempt >= 12) throw error;
        diag(`wallet: DUST is still tied up in the previous transaction; trying again in 6 s (${attempt}/12)`);
        await new Promise((resolve) => setTimeout(resolve, 6_000));
      }
    }
  }

  private async activeProtocol(): Promise<ProtocolVersion.ProtocolVersion> {
    return (await firstValueFrom(this.sdk.facade.state())).activeProtocolVersion;
  }

  /** Sign a recipe, add the remaining proofs, and unwrap the finished ledger transaction. */
  private async finish(recipe: Parameters<SdkWallet['facade']['signRecipe']>[0]): Promise<FinalizedTransaction> {
    const { facade, keystore } = this.sdk;
    const signed = await facade.signRecipe(recipe, (payload) => keystore.signDataAsync(payload));
    const finalized = await facade.finalizeRecipe(signed);
    const accepted = ProtocolVersion.epochOf(await this.activeProtocol(), DefaultForkSchedule.v9);
    const unwrapped = WalletTransaction.unwrapWithin<FinalizedTransaction>(finalized, accepted);
    if (unwrapped._tag === 'Left') throw unwrapped.left;
    return unwrapped.right;
  }
}

/** A short stable name for a secret, so saved state can be found again without storing the secret as a key. */
async function fingerprint(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest).slice(0, 12), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
