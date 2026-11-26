// Deploying and minting on Midnight Preprod, with Midnight.js.
//
// The payout itself does not need this file: it is a plain wallet transfer
// (see src/fanout.ts). This file is for the two contract transactions that
// come first, deploying the token and minting it, plus checking on a
// transaction afterwards.
//
// Midnight.js builds a contract transaction from six "providers". In a browser
// DApp almost all of them are the user's wallet:
//
//   publicDataProvider    the indexer the wallet is configured with
//   zkConfigProvider      this site's own files (keys/, zkir/, compiler/)
//   proofProvider         the wallet proves (nothing else to run)
//   privateStateProvider  memory, seeded from localStorage (./private-state.ts)
//   walletProvider        the wallet balances the transaction and pays the fee
//   midnightProvider      the wallet submits the transaction
//
// The provider wiring follows the official examples:
// https://github.com/midnightntwrk/midnight-examples
import { deployContract, findDeployedContract } from '@midnight-ntwrk/midnight-js-contracts';
import { dappConnectorProofProvider } from '@midnight-ntwrk/midnight-js-dapp-connector-proof-provider';
import { FetchZkConfigProvider } from '@midnight-ntwrk/midnight-js-fetch-zk-config-provider';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { CostModel, Transaction, rawTokenType } from '@midnight-ntwrk/midnight-js-protocol/v9';
import { encodeCoinPublicKey } from '@midnight-ntwrk/midnight-js-protocol/v9/compact-runtime';
import {
  createLedger9MidnightProvider,
  createLedger9WalletProvider,
  SucceedEntirely,
  type MidnightProviders,
} from '@midnight-ntwrk/midnight-js-types';
import { fromHex, parseCoinPublicKeyToHex, parseEncPublicKeyToHex, toHex } from '@midnight-ntwrk/midnight-js-utils';
import {
  CompiledFanoutToken,
  pureCircuits,
  type FanoutTokenCircuits,
  type FanoutTokenPrivateState,
} from '../../contract/index';
import type { Backend, TokenInfo, TokenMeta, TokenSecrets, TxOutcome, TxRef } from '../backend';
import { NETWORK_ID, type Session } from '../wallet';
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

/** The connected wallet's coin public key as the contract wants it: `{ bytes }`. */
function ownCoinPublicKey(session: Session): { bytes: Uint8Array } {
  return { bytes: encodeCoinPublicKey(parseCoinPublicKeyToHex(session.shieldedCoinPublicKey, NETWORK_ID)) };
}

/** Read a transaction's id and hash from its serialized form. */
function describeTx(tx: string): TxRef {
  const parsed = Transaction.deserialize('signature', 'proof', 'binding', fromHex(tx));
  const [txId] = parsed.identifiers();
  if (!txId) throw new Error('The transaction has no identifier.');
  return { txId, txHash: parsed.transactionHash() };
}

/**
 * Midnight.js rewraps any error the wallet throws and drops its `code`, so the
 * UI could no longer tell "the user declined" from "not enough tDUST". This
 * keeps the wallet's own error from the latest call so it can be rethrown.
 */
interface WalletErrors {
  last: unknown;
}

async function createProviders(session: Session, walletErrors: WalletErrors): Promise<Providers> {
  const { api } = session;
  const fromWallet = async <T>(call: () => Promise<T>): Promise<T> => {
    try {
      return await call();
    } catch (error) {
      walletErrors.last = error;
      throw error;
    }
  };
  const config = await api.getConfiguration();

  // The indexer provider's default WebSocket is a Node one, so pass the browser's.
  const publicDataProvider = indexerPublicDataProvider(
    config.indexerUri,
    config.indexerWsUri,
    globalThis.WebSocket as unknown as Parameters<typeof indexerPublicDataProvider>[2],
  );

  // Keys and ZKIR are served by this site, next to index.html (see publicDir in
  // vite.config.ts). The provider checks each file against the compiler's
  // manifest, so a tampered key is rejected.
  const siteRoot = new URL(import.meta.env.BASE_URL, globalThis.location.href).toString();
  const zkConfigProvider = new FetchZkConfigProvider<FanoutTokenCircuits>(siteRoot, {
    fetchFunc: (input, init) => fetch(input, init),
  });

  // The wallet makes the proofs. It gets the key material from zkConfigProvider.
  const proofProvider = await dappConnectorProofProvider(api, zkConfigProvider, CostModel.initialCostModel());

  // The connector gives keys as Bech32m text. The ledger works with hex.
  const { shieldedCoinPublicKey, shieldedEncryptionPublicKey } = await api.getShieldedAddresses();
  const coinPublicKey = parseCoinPublicKeyToHex(shieldedCoinPublicKey, config.networkId);
  const encryptionPublicKey = parseEncPublicKeyToHex(shieldedEncryptionPublicKey, config.networkId);

  return {
    privateStateProvider: inMemoryPrivateStateProvider<typeof PRIVATE_STATE_ID, FanoutTokenPrivateState>(),
    publicDataProvider,
    zkConfigProvider,
    proofProvider,
    walletProvider: createLedger9WalletProvider({
      getCoinPublicKey: () => coinPublicKey,
      getEncryptionPublicKey: () => encryptionPublicKey,
      // Midnight.js hands over a proven transaction that still lacks a fee.
      // The wallet adds tDUST, signs and seals it. The user approves this.
      balanceTx: async (tx) => {
        const { tx: balanced } = await fromWallet(() => api.balanceUnsealedTransaction(toHex(tx.serialize())));
        return Transaction.deserialize('signature', 'proof', 'binding', fromHex(balanced));
      },
    }),
    midnightProvider: createLedger9MidnightProvider(async (tx) => {
      const bytes = tx.serialize();
      await fromWallet(() => api.submitTransaction(toHex(bytes)));
      return describeTx(toHex(bytes)).txId;
    }),
    config: { networkId: config.networkId, ttlSeconds: TX_TTL_SECONDS },
  };
}

export function createRealBackend(): Backend {
  // One set of providers per connected wallet, built on first use.
  const walletErrors: WalletErrors = { last: undefined };
  const providersBySession = new WeakMap<Session, Promise<Providers>>();
  const providersFor = (session: Session): Promise<Providers> => {
    let providers = providersBySession.get(session);
    if (!providers) providersBySession.set(session, (providers = createProviders(session, walletErrors)));
    return providers;
  };

  /** Run a contract transaction; if the wallet refused it, throw the wallet's own error. */
  const withWalletErrors = async <T>(transaction: () => Promise<T>): Promise<T> => {
    walletErrors.last = undefined;
    try {
      return await transaction();
    } catch (error) {
      throw walletErrors.last ?? error;
    }
  };

  return {
    describeTx,

    async deployToken(session: Session, meta: TokenMeta, secrets: TokenSecrets): Promise<TokenInfo> {
      const providers = await providersFor(session);
      const secretNonce = fromHex(secrets.secretNonce);

      // The contract never stores the owner's key. It stores a commitment to
      // this id: hash(owner coin public key, secret nonce).
      const ownerId = pureCircuits._computeOwnerId(
        { is_left: true, left: ownCoinPublicKey(session), right: { bytes: new Uint8Array(32) } },
        secretNonce,
      );

      const deployed = await withWalletErrors(() =>
        deployContract(providers, {
          compiledContract: CompiledFanoutToken,
          privateStateId: PRIVATE_STATE_ID,
          initialPrivateState: { secretNonce },
          args: [ownerId, fromHex(secrets.instanceSalt), TOKEN_DOMAIN, meta.name, meta.symbol, BigInt(meta.decimals)],
        }),
      );

      const contractAddress = deployed.deployTxData.public.contractAddress;
      return { ...meta, contractAddress, tokenType: rawTokenType(TOKEN_DOMAIN, contractAddress) };
    },

    async mint(session: Session, token: TokenInfo, secrets: TokenSecrets, amount: bigint): Promise<TxRef> {
      const providers = await providersFor(session);
      const contract = await findDeployedContract(providers, {
        contractAddress: token.contractAddress,
        compiledContract: CompiledFanoutToken,
        privateStateId: PRIVATE_STATE_ID,
        initialPrivateState: { secretNonce: fromHex(secrets.secretNonce) },
      });

      // mint(recipient, amount, nonce): the recipient is the caller's own coin
      // public key, so the new coin lands in the connected wallet. The nonce
      // only has to be unique per coin.
      const result = await withWalletErrors(() =>
        contract.callTx.mint(ownCoinPublicKey(session), amount, randomBytes32()),
      );
      return { txId: result.public.txId, txHash: result.public.txHash };
    },

    async checkTx(session: Session, txId: string, maxWaitMs: number): Promise<TxOutcome> {
      const providers = await providersFor(session);
      try {
        const found = await providers.publicDataProvider.watchForTxData(txId, { maxWaitMs });
        return found.status === SucceedEntirely ? 'finalized' : 'failed';
      } catch {
        // The wait ran out: the indexer has not seen this transaction.
        return 'pending';
      }
    },
  };
}
