// A Midnight wallet running in this page, built on the official wallet SDK.
//
// This is the same code a backend would run: one seed, three sub-wallets
// (shielded coins, unshielded NIGHT, DUST for fees) behind one "facade", an
// indexer to sync from, a node to submit to and a proof server to prove with.
// Nothing here depends on a browser extension.
import { LedgerParameters } from '@midnight-ntwrk/midnight-js-protocol/v9';
import {
  CustomForkingDustWallet,
  DefaultForkSchedule,
  dustVariantConfigurations,
  dustWalletProbes,
  HDWallet,
  InMemoryTransactionHistoryStorage,
  Option,
  PublicKey,
  Roles,
  ShieldedWallet,
  UnshieldedWallet,
  WalletEntrySchema,
  WalletFacade,
  createKeystore,
  mergeWalletEntries,
  type UnshieldedKeystore,
} from 'fanout-wallet-sdk';
import { V1Builder } from 'fanout-wallet-sdk';
import { DustSync, V2Builder } from 'fanout-wallet-sdk';

/** Where the wallet reads the chain, submits to it, and gets its proofs. */
export interface Endpoints {
  readonly networkId: string;
  /** Indexer GraphQL over HTTP and over WebSocket. */
  readonly indexer: string;
  readonly indexerWS: string;
  /** Node RPC over WebSocket. */
  readonly nodeWS: string;
  readonly proofServer: string;
}

/** The three sub-wallets' saved state, so a later visit resumes instead of syncing from the start. */
export interface SavedWalletState {
  readonly shielded: string;
  readonly unshielded: string;
  readonly dust: string;
}

export interface SdkWallet {
  readonly facade: WalletFacade;
  /** Signs with the key that owns the wallet's NIGHT. */
  readonly keystore: UnshieldedKeystore;
  /** The three role seeds, as the facade wants them. */
  readonly seeds: { readonly shielded: Uint8Array; readonly unshielded: Uint8Array; readonly dust: Uint8Array };
  /** True when the wallet resumed from saved state. */
  readonly restored: boolean;
  /** The sub-wallets' current state as text, to save and resume from later. */
  serialize(): Promise<SavedWalletState>;
}

type Role = (typeof Roles)[keyof typeof Roles];

/**
 * Where each network's DUST history begins on Ledger 9: the last DUST event
 * before the switch, and the protocol version the switch went to.
 *
 * A new wallet has no DUST from before that point, so it starts there. The SDK
 * can search for this point itself (`findDustTimelineStart`), but that search
 * takes from half a minute to two and the SDK gives up on it after 30 seconds,
 * after which the wallet silently replays every DUST event since genesis:
 * hours. The point never moves once a network has switched, so it is written
 * down here. Found on 2026-11-27 with
 * `dustWalletProbes({ ...config, skipLedgerV8DustHistory: true }).dustTimelineStartProbe()`.
 */
const DUST_START_ON_LEDGER_9: Readonly<Record<string, { cursor: bigint; version: bigint }>> = {
  preprod: { cursor: 1_857_961n, version: 2_001_100n },
  preview: { cursor: 2_875n, version: 2_001_100n },
  mainnet: { cursor: 1_623_186n, version: 2_001_100n },
};

/**
 * The DUST wallet, with the SDK's fast sync.
 *
 * The SDK's default DUST wallet replays every DUST event on the chain. On
 * Ledger 9 the SDK also has a fast path ("projections"): it asks the indexer
 * directly for what concerns this wallet (its DUST generation, its spent DUST,
 * and the state of the trees) and is done in seconds. It is opt-in, so the
 * wallet is composed here by hand: the standard Ledger 8 variant, and the
 * Ledger 9 variant with the fast sync, started where Ledger 9 begins.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function FastDustWallet(configuration: any) {
  const { v1, v2, migration } = dustVariantConfigurations(configuration);
  const knownStart = DUST_START_ON_LEDGER_9[configuration.networkId as string];
  return CustomForkingDustWallet(
    {
      ...configuration,
      ...dustWalletProbes(configuration),
      ...(knownStart ? { dustTimelineStartProbe: () => Promise.resolve(Option.some(knownStart)) } : {}),
    },
    { builder: new V1Builder().withDefaults(), configuration: v1 } as never,
    {
      // The builder's types do not follow a swapped sync service, hence the cast.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      builder: (new V2Builder().withDefaults() as any)
        .withSync(DustSync.makeEventLessSyncService, DustSync.makeEventLessSyncCapability)
        .withStartAuxDefaults()
        .withMigration(migration),
      configuration: v2,
    } as never,
  );
}

/** One seed feeds three keys, one per role, by standard HD derivation (account 0, key 0). */
function roleSeed(masterSeed: Uint8Array, role: Role): Uint8Array {
  const hd = HDWallet.fromSeed(masterSeed);
  if (hd.type !== 'seedOk') throw new Error('That seed is not valid.');
  const derived = hd.hdWallet.selectAccount(0).selectRole(role).deriveKeyAt(0);
  if (derived.type === 'keyOutOfBounds') throw new Error('Could not derive a key from that seed.');
  return derived.key;
}

export const hexToBytes = (hex: string): Uint8Array =>
  Uint8Array.from(hex.match(/../g) ?? [], (pair) => parseInt(pair, 16));

/** Build (but do not start) a wallet from a 32-byte seed given as 64 hex characters. */
export async function buildSdkWallet(
  seedHex: string,
  endpoints: Endpoints,
  note: (step: string) => void = () => undefined,
  saved?: SavedWalletState,
): Promise<SdkWallet> {
  if (!/^[0-9a-fA-F]{64}$/.test(seedHex)) throw new Error('A seed is 64 hex characters.');
  const master = hexToBytes(seedHex);
  const seeds = {
    shielded: roleSeed(master, Roles.Zswap),
    unshielded: roleSeed(master, Roles.NightExternal),
    dust: roleSeed(master, Roles.Dust),
  };

  const config = {
    forks: DefaultForkSchedule,
    networkId: endpoints.networkId,
    indexerClientConnection: { indexerHttpUrl: endpoints.indexer, indexerWsUrl: endpoints.indexerWS },
    relayURL: new URL(endpoints.nodeWS),
    provingServerUrl: new URL(endpoints.proofServer),
    txHistoryStorage: new InMemoryTransactionHistoryStorage(WalletEntrySchema, mergeWalletEntries),
    costParameters: {
      ledgerParams: LedgerParameters.initialParameters(),
      additionalFeeOverhead: 1_000n,
      feeBlocksMargin: 5,
    },
    // How the wallet applies chain events while syncing. The SDK's default is
    // 10 events, then a 4 ms pause, which in a browser (where every pause is at
    // least 4 ms) halves the speed of a first sync. With larger batches the
    // sync runs as fast as the processor can check each shielded event against
    // this wallet's keys: about 1,200 events a second, measured on Preprod.
    batchUpdates: { size: 500, timeout: 25, spacing: 1 },
    // How precisely the wallet tells the indexer which spent DUST it is looking
    // for. To learn whether its DUST coins were spent, the wallet sends only
    // the first bytes of each coin's nullifier and filters the answer itself,
    // so the indexer cannot tell which coin is the wallet's. The SDK's default
    // (7) sends one byte: on Preprod that returns about 4,000 transactions and
    // 24 MB per coin, 42 seconds each, on every check. At 1 it sends two bytes
    // (with Preprod's 160,000 DUST coins): about 20 transactions, half a
    // second. The price is a smaller crowd to hide in. Measured on Preprod on
    // 2026-11-26; raise it for more privacy.
    anonymityLevel: 1,
    // The networks crossed from Ledger 8 to Ledger 9 in place. A new wallet has no
    // DUST history from before that, so do not replay it (see FastDustWallet).
    skipLedgerV8DustHistory: true,
  };

  note('deriving keys');
  const keystore = createKeystore({ kind: 'schnorr', secret: seeds.unshielded }, endpoints.networkId);
  // The SDK's configuration type is assembled per sub-wallet; this one object carries what all three need.
  const shared = config as unknown as Parameters<typeof ShieldedWallet>[0];
  const unshieldedConfig = shared as unknown as Parameters<typeof UnshieldedWallet>[0];
  const dustConfig = shared;

  const fresh = async () => ({
    shielded: await ShieldedWallet(shared).startWithSeed(seeds.shielded),
    unshielded: await UnshieldedWallet(unshieldedConfig).startWithPublicKey(PublicKey.fromKeyStore(keystore)),
    dust: await FastDustWallet(dustConfig).startWithSeed(seeds.dust),
  });
  const fromSaved = (state: SavedWalletState) => ({
    shielded: ShieldedWallet(shared).restore(state.shielded),
    unshielded: UnshieldedWallet(unshieldedConfig).restore(state.unshielded),
    dust: FastDustWallet(dustConfig).restore(state.dust),
  });

  // Resume from saved state when there is some; otherwise start from nothing.
  let restored = false;
  let wallets: Awaited<ReturnType<typeof fresh>> | ReturnType<typeof fromSaved>;
  try {
    if (!saved) throw new Error('no saved state');
    note('restoring the saved wallet state');
    wallets = fromSaved(saved);
    restored = true;
  } catch (error) {
    if (saved) note(`saved state could not be used (${String(error).slice(0, 80)}); starting fresh`);
    note('creating the shielded, unshielded and DUST wallets');
    wallets = await fresh();
  }

  note('connecting the wallet to the indexer, the node and the proof server');
  const facade = await WalletFacade.init({
    configuration: shared as unknown as Parameters<typeof WalletFacade.init>[0]['configuration'],
    shielded: () => wallets.shielded as never,
    unshielded: () => wallets.unshielded as never,
    dust: () => wallets.dust as never,
  });
  note('wallet ready');
  return {
    facade,
    keystore,
    seeds,
    restored,
    serialize: async () => ({
      shielded: await facade.shielded.serializeState(),
      unshielded: await facade.unshielded.serializeState(),
      dust: await facade.dust.serializeState(),
    }),
  };
}
