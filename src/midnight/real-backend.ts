// Deploying and minting the token on Midnight, with Midnight.js.
//
// The payout itself does not need this file: it is a plain wallet transfer
// (see src/fanout.ts). This file is for the two contract transactions that
// come first, deploying the token and minting it, plus reading the contract
// and checking on a transaction afterwards.
//
// Midnight.js builds a contract transaction from six "providers":
//
//   publicDataProvider    the indexer (Blockfrost)
//   zkConfigProvider      this site's own files (keys/, zkir/, compiler/)
//   proofProvider         the proof server you run
//   privateStateProvider  memory, seeded from localStorage (./private-state.ts)
//   walletProvider        the in-page wallet adds the DUST fee and signs
//   midnightProvider      the in-page wallet submits to the node
//
// A backend would wire the same six, with a file or database in place of the
// browser storage.
import { deployContract, findDeployedContract } from '@midnight-ntwrk/midnight-js-contracts';
import { FetchZkConfigProvider } from '@midnight-ntwrk/midnight-js-fetch-zk-config-provider';
import { httpClientProofProvider } from '@midnight-ntwrk/midnight-js-http-client-proof-provider';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { Transaction, rawTokenType, type FinalizedTransaction } from '@midnight-ntwrk/midnight-js-protocol/v9';
import { ContractState, encodeCoinPublicKey } from '@midnight-ntwrk/midnight-js-protocol/v9/compact-runtime';
import {
  createLedger9MidnightProvider,
  createLedger9WalletProvider,
  SucceedEntirely,
  type MidnightProviders,
} from '@midnight-ntwrk/midnight-js-types';
import { fromHex } from '@midnight-ntwrk/midnight-js-utils';
import {
  CompiledFanoutToken,
  ledger,
  pureCircuits,
  type FanoutTokenCircuits,
  type FanoutTokenPrivateState,
} from '../../contract/index';
import type { Backend, Stage, TokenInfo, TokenMeta, TokenSecrets, TxOutcome, TxRef } from '../backend';
import { describeError, diag } from '../diag';
import { describeTx } from '../fanout';
import type { BrowserWallet } from '../wallet/browser-wallet';
import type { Endpoints } from '../wallet/sdk-wallet';
import { inMemoryPrivateStateProvider } from './private-state';

const PRIVATE_STATE_ID = 'fanoutToken';
type Providers = MidnightProviders<FanoutTokenCircuits, typeof PRIVATE_STATE_ID, FanoutTokenPrivateState>;

/** How long a contract transaction built here stays valid, in seconds. */
const TX_TTL_SECONDS = 3600;

/**
 * The token's domain separator. A token's type is derived from this and the
 * contract's address, so every deployment gets a different token type even
 * though the domain is the same text.
 */
const TOKEN_DOMAIN = new Uint8Array(32);
TOKEN_DOMAIN.set(new TextEncoder().encode('shielded-fanout-example'));

const randomBytes32 = (): Uint8Array => crypto.getRandomValues(new Uint8Array(32));

/** The wallet's coin public key as the contract wants it: `{ bytes }`. */
const ownerKey = (wallet: BrowserWallet): { bytes: Uint8Array } => ({ bytes: encodeCoinPublicKey(wallet.coinPublicKey) });

/** Fail with `message` if `work` takes longer than `ms`. */
function within<T>(ms: number, message: string, work: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * What the providers share with the transaction running on them.
 *
 * `lastError`: Midnight.js rewraps an error from the wallet or the proof
 * server and hides its message. The original is kept here to be rethrown.
 * `onStage`: tells the UI where the transaction is.
 */
interface Shared {
  lastError: unknown;
  onStage: (stage: Stage) => void;
}

function createProviders(wallet: BrowserWallet, endpoints: Endpoints, shared: Shared): Providers {
  /** Run one outside call, timing it and keeping its error. */
  const outside = async <T>(what: string, call: () => Promise<T>): Promise<T> => {
    const startedAt = Date.now();
    diag(`${what}: start`);
    try {
      const result = await call();
      diag(`${what}: done`, { ms: Date.now() - startedAt });
      return result;
    } catch (error) {
      shared.lastError = error;
      diag(`${what}: FAILED`, { ms: Date.now() - startedAt, error: describeError(error) });
      throw error;
    }
  };

  // The indexer provider's default WebSocket is a Node one, so pass the browser's.
  const publicDataProvider = indexerPublicDataProvider(
    endpoints.indexer,
    endpoints.indexerWS,
    globalThis.WebSocket as unknown as Parameters<typeof indexerPublicDataProvider>[2],
  );

  // Keys and ZKIR are served by this site, next to index.html (see
  // scripts/copy-zk.mjs). The provider checks each file against the compiler's
  // manifest, so a tampered key is rejected.
  const siteRoot = new URL(import.meta.env.BASE_URL, globalThis.location.href).toString();
  const zkConfigProvider = new FetchZkConfigProvider<FanoutTokenCircuits>(siteRoot, {
    fetchFunc: (input, init) => fetch(input, init),
  });

  // The proof server makes the proofs. It gets the circuit's key material from
  // zkConfigProvider, and the private inputs from this page.
  const proofProvider = httpClientProofProvider(endpoints.proofServer, zkConfigProvider);
  const stagedProofProvider = new Proxy(proofProvider, {
    get(target, key, receiver) {
      const value: unknown = Reflect.get(target, key, receiver);
      if (key !== 'proveTx' || typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        shared.onStage('proving');
        return outside('prove on the proof server', () => value.apply(target, args) as Promise<unknown>);
      };
    },
  });

  return {
    privateStateProvider: inMemoryPrivateStateProvider<typeof PRIVATE_STATE_ID, FanoutTokenPrivateState>(),
    publicDataProvider,
    zkConfigProvider,
    proofProvider: stagedProofProvider,
    walletProvider: createLedger9WalletProvider({
      getCoinPublicKey: () => wallet.coinPublicKey,
      getEncryptionPublicKey: () => wallet.encryptionPublicKey,
      // Midnight.js hands over a proven transaction that still lacks a fee.
      // The wallet adds DUST, signs and seals it.
      balanceTx: async (tx) => {
        shared.onStage('signing');
        const unbound = Transaction.deserialize('signature', 'proof', 'pre-binding', tx.serialize());
        return outside('wallet: add the fee and sign', () => wallet.balanceAndSign(unbound as never));
      },
    }),
    midnightProvider: createLedger9MidnightProvider(async (tx) => {
      shared.onStage('submitting');
      const finished: FinalizedTransaction = Transaction.deserialize('signature', 'proof', 'binding', tx.serialize());
      await outside('wallet: submit to the node', () => wallet.submit(finished));
      shared.onStage('finalizing');
      return describeTx(finished).txId;
    }),
    config: { networkId: endpoints.networkId, ttlSeconds: TX_TTL_SECONDS },
  };
}

export function createRealBackend(endpoints: Endpoints): Backend {
  const shared: Shared = { lastError: undefined, onStage: () => undefined };

  // One set of providers per wallet, built on first use.
  const cache = new WeakMap<BrowserWallet, Providers>();
  const providersFor = (wallet: BrowserWallet): Providers => {
    let providers = cache.get(wallet);
    if (!providers) cache.set(wallet, (providers = createProviders(wallet, endpoints, shared)));
    return providers;
  };

  /** Run one contract transaction, reporting its stages and keeping the original error. */
  const transact = async <T>(
    name: string,
    onStage: ((stage: Stage) => void) | undefined,
    transaction: () => Promise<T>,
  ): Promise<T> => {
    shared.lastError = undefined;
    shared.onStage = (stage) => {
      diag(`${name}: stage ${stage}`);
      onStage?.(stage);
    };
    shared.onStage('preparing');
    try {
      const result = await transaction();
      diag(`${name}: finalized`);
      return result;
    } catch (error) {
      diag(`${name}: FAILED`, describeError(error));
      throw shared.lastError ?? error;
    } finally {
      shared.onStage = () => undefined;
    }
  };

  /** The token contract at `contractAddress` as the chain has it, or `null`. */
  const readToken = async (wallet: BrowserWallet, contractAddress: string): Promise<TokenInfo | null> => {
    diag(`reading contract ${contractAddress.slice(0, 12)}… from the indexer`);
    const read = await within(
      30_000,
      'The indexer did not answer within 30 seconds.',
      providersFor(wallet).publicDataProvider.queryContractState(contractAddress),
    );
    if (read === null) {
      diag('the indexer has no contract at that address');
      return null;
    }
    if (read.contractState.era !== 'v9') throw new Error('That contract was not deployed on Ledger 9.');
    let state;
    try {
      state = ledger(read.contractState.deserialize({ v9: ContractState }).data);
    } catch {
      throw new Error('That address holds a contract, but not this token contract.');
    }
    diag(`contract found on chain: ${state._name} (${state._symbol})`);
    return {
      contractAddress,
      name: state._name,
      symbol: state._symbol,
      decimals: Number(state._decimals),
      tokenType: rawTokenType(state._domain, contractAddress),
    };
  };

  return {
    readToken,

    async deployToken(wallet, meta: TokenMeta, secrets: TokenSecrets, onStage): Promise<TokenInfo> {
      return transact('deploy', onStage, async () => {
        const secretNonce = fromHex(secrets.secretNonce);

        // The contract never stores the owner's key. It stores a commitment to
        // this id: hash(owner coin public key, secret nonce).
        const ownerId = pureCircuits._computeOwnerId(
          { is_left: true, left: ownerKey(wallet), right: { bytes: new Uint8Array(32) } },
          secretNonce,
        );

        const deployed = await deployContract(providersFor(wallet), {
          compiledContract: CompiledFanoutToken,
          privateStateId: PRIVATE_STATE_ID,
          initialPrivateState: { secretNonce },
          args: [ownerId, fromHex(secrets.instanceSalt), TOKEN_DOMAIN, meta.name, meta.symbol, BigInt(meta.decimals)],
        });

        const { contractAddress, txHash } = deployed.deployTxData.public;
        diag(`deploy: transaction ${txHash} reported finalized, contract ${contractAddress}`);

        // Do not take that on trust: read the contract back from the chain.
        for (let attempt = 0; attempt < 6; attempt++) {
          const onChain = await readToken(wallet, contractAddress);
          if (onChain) return onChain;
          await new Promise((resolve) => setTimeout(resolve, 5_000));
        }
        throw new Error(
          `The deploy transaction (${txHash}) was reported as finalized, but no contract exists at ${contractAddress}. Nothing was saved.`,
        );
      });
    },

    async mint(wallet, token: TokenInfo, secrets: TokenSecrets, amount: bigint, onStage): Promise<TxRef> {
      return transact('mint', onStage, async () => {
        if ((await readToken(wallet, token.contractAddress)) === null) {
          throw new Error('This contract is not on this network, so there is nothing to mint from. Deploy or join a contract first.');
        }
        diag('mint: attaching to the contract');
        const contract = await within(
          60_000,
          'Attaching to the contract took more than a minute. The indexer may be unreachable.',
          findDeployedContract(providersFor(wallet), {
            contractAddress: token.contractAddress,
            compiledContract: CompiledFanoutToken,
            privateStateId: PRIVATE_STATE_ID,
            initialPrivateState: { secretNonce: fromHex(secrets.secretNonce) },
          }),
        );

        // mint(recipient, amount, nonce): the recipient is the caller's own coin
        // public key, so the new coin lands in this wallet. The nonce only has
        // to be unique per coin.
        diag('mint: building the transaction');
        const result = await contract.callTx.mint(ownerKey(wallet), amount, randomBytes32());
        return { txId: result.public.txId, txHash: result.public.txHash };
      });
    },

    async checkTx(wallet: BrowserWallet, txId: string, maxWaitMs: number): Promise<TxOutcome> {
      try {
        const found = await providersFor(wallet).publicDataProvider.watchForTxData(txId, { maxWaitMs });
        return found.status === SucceedEntirely ? 'finalized' : 'failed';
      } catch {
        // The wait ran out: the indexer has not seen this transaction.
        return 'pending';
      }
    },

    async txRaw(txHash: string): Promise<string | null> {
      const response = await fetch(endpoints.indexer, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query: `{ transactions(offset: {hash: "${txHash}"}) { raw } }` }),
        signal: AbortSignal.timeout(30_000),
      });
      const body = (await response.json()) as { data?: { transactions?: { raw: string }[] }; errors?: { message: string }[] };
      if (!response.ok || body.errors) {
        throw new Error(`The indexer could not serve the transaction: ${body.errors?.[0]?.message ?? response.status}`);
      }
      return body.data?.transactions?.[0]?.raw ?? null;
    },

    async txIsAbsent(txId: string): Promise<boolean> {
      // Asked directly, so that "the indexer has no such transaction" (an empty
      // list) cannot be confused with "the indexer could not be reached" (an error).
      const response = await fetch(endpoints.indexer, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query: `{ transactions(offset: {identifier: "${txId}"}) { hash } }` }),
        signal: AbortSignal.timeout(20_000),
      });
      const body = (await response.json()) as { data?: { transactions?: unknown[] }; errors?: { message: string }[] };
      if (!response.ok || body.errors || !Array.isArray(body.data?.transactions)) {
        throw new Error(`The indexer could not say whether the transaction exists: ${body.errors?.[0]?.message ?? response.status}`);
      }
      return body.data.transactions.length === 0;
    },
  };
}
