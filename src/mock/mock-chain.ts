// A pretend wallet and a pretend chain, both in memory.
//
// `pnpm dev:mock` and the tests use this so the whole flow can be clicked
// through with no wallet extension, no funds and no network. Nothing here
// touches Midnight. It imitates the parts of the DApp Connector API that the
// app calls, including the errors a real wallet gives.
import type { ConnectedAPI, DesiredOutput, InitialAPI } from '@midnight-ntwrk/dapp-connector-api';
import { bech32m } from '@scure/base';
import { shieldedAddressPrefix } from '../address';
import type { Backend, TokenInfo, TxOutcome, TxRef } from '../backend';
import { NETWORK_ID } from '../wallet';

export interface MockOptions {
  /** Start with tNIGHT and tDUST. `false` shows what an unfunded user sees. */
  readonly funded?: boolean;
  /** How long each pretend network step takes. Tests use 0. */
  readonly delayMs?: number;
}

export interface MockChain {
  /** Goes under `window.midnight`, like a wallet extension would put itself. */
  readonly wallet: InitialAPI;
  readonly backend: Backend;
  /** Valid Preprod-format addresses to pay in mock mode. */
  readonly sampleAddresses: readonly string[];
  /** What each address has received so far, per token type. For tests. */
  received(address: string, tokenType: string): bigint;
}

const randomHex = (bytes: number): string =>
  Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) => b.toString(16).padStart(2, '0')).join('');

/** A well-formed shielded address that belongs to nobody. */
function randomShieldedAddress(): string {
  const payload = crypto.getRandomValues(new Uint8Array(64));
  return bech32m.encode(shieldedAddressPrefix(NETWORK_ID), bech32m.toWords(payload), false);
}

/** The error shape a real wallet throws (see "Errors" in the connector specification). */
function connectorError(code: string, reason: string): Error {
  return Object.assign(new Error(reason), { type: 'DAppConnectorAPIError', code, reason });
}

const toHexJson = (value: unknown): string =>
  Array.from(new TextEncoder().encode(JSON.stringify(value)), (b) => b.toString(16).padStart(2, '0')).join('');

const fromHexJson = <T>(hex: string): T =>
  JSON.parse(new TextDecoder().decode(Uint8Array.from(hex.match(/../g) ?? [], (pair) => parseInt(pair, 16)))) as T;

export function createMockChain({ funded = true, delayMs = 700 }: MockOptions = {}): MockChain {
  const pause = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, delayMs));

  const ownAddress = randomShieldedAddress();
  let night = funded ? 1_000_000_000n : 0n; // 1,000 tNIGHT
  let dust = funded ? 5_000_000_000_000_000n : 0n; // 5 tDUST
  const FEE = 1_000_000_000_000n; // a pretend fee of 0.001 tDUST

  const balances = new Map<string, bigint>(); // the wallet's shielded tokens
  const receipts = new Map<string, bigint>(); // `${address}|${tokenType}` -> received
  const built = new Map<string, DesiredOutput[]>(); // transfers the wallet built
  const outcomes = new Map<string, TxOutcome>(); // what the "indexer" knows

  const payFee = (): void => {
    if (dust < FEE) throw connectorError('InsufficientFunds', 'Not enough tDUST to pay the fee.');
    dust -= FEE;
  };

  const newTx = (): TxRef => ({ txId: randomHex(32), txHash: randomHex(32) });

  const connected = {
    async getConfiguration() {
      return {
        indexerUri: 'http://mock.invalid/graphql',
        indexerWsUri: 'ws://mock.invalid/graphql/ws',
        substrateNodeUri: 'ws://mock.invalid',
        networkId: NETWORK_ID,
      };
    },
    async getShieldedAddresses() {
      return {
        shieldedAddress: ownAddress,
        shieldedCoinPublicKey: `mock-coin-public-key-${ownAddress.slice(-12)}`,
        shieldedEncryptionPublicKey: 'mock-encryption-public-key',
      };
    },
    async getUnshieldedBalances() {
      return { ['00'.repeat(32)]: night };
    },
    async getDustBalance() {
      return { cap: dust, balance: dust };
    },
    async getShieldedBalances() {
      return Object.fromEntries(balances);
    },

    // The call a fanout is made of: every recipient in one transfer.
    async makeTransfer(outputs: DesiredOutput[]) {
      await pause();
      const needed = new Map<string, bigint>();
      for (const output of outputs) needed.set(output.type, (needed.get(output.type) ?? 0n) + output.value);
      for (const [type, amount] of needed) {
        if ((balances.get(type) ?? 0n) < amount) {
          throw connectorError('InsufficientFunds', 'Not enough of the token to cover every recipient.');
        }
      }
      if (dust < FEE) throw connectorError('InsufficientFunds', 'Not enough tDUST to pay the fee.');
      const ref = newTx();
      built.set(ref.txId, outputs);
      return { tx: toHexJson(ref) };
    },

    async submitTransaction(tx: string) {
      await pause();
      const { txId } = fromHexJson<TxRef>(tx);
      const outputs = built.get(txId);
      if (!outputs) throw connectorError('InvalidRequest', 'Unknown transaction.');
      payFee();
      // All outputs apply together, or (had anything above thrown) none do.
      for (const output of outputs) {
        balances.set(output.type, (balances.get(output.type) ?? 0n) - output.value);
        const receiptKey = `${output.recipient}|${output.type}`;
        receipts.set(receiptKey, (receipts.get(receiptKey) ?? 0n) + output.value);
      }
      built.delete(txId);
      setTimeout(() => outcomes.set(txId, 'finalized'), delayMs);
    },
  };

  const backend: Backend = {
    async deployToken(_session, meta) {
      await pause();
      payFee();
      return { ...meta, contractAddress: randomHex(32), tokenType: randomHex(32) };
    },
    async mint(_session, token: TokenInfo, _secrets, amount) {
      await pause();
      payFee();
      const ref = newTx();
      outcomes.set(ref.txId, 'finalized');
      // A real wallet needs a moment to notice its new coin.
      setTimeout(() => balances.set(token.tokenType, (balances.get(token.tokenType) ?? 0n) + amount), delayMs);
      return ref;
    },
    describeTx: (tx) => fromHexJson<TxRef>(tx),
    async checkTx(_session, txId, maxWaitMs) {
      const deadline = Date.now() + maxWaitMs;
      for (;;) {
        const outcome = outcomes.get(txId);
        if (outcome) return outcome;
        if (Date.now() >= deadline) return 'pending';
        await new Promise((resolve) => setTimeout(resolve, Math.max(5, Math.min(100, delayMs))));
      }
    },
  };

  const wallet: InitialAPI = {
    rdns: 'example.mock-wallet',
    name: 'Mock wallet',
    icon: '',
    apiVersion: '4.0.1',
    // Only the methods this app calls are implemented.
    connect: async () => connected as unknown as ConnectedAPI,
  };

  return {
    wallet,
    backend,
    sampleAddresses: [randomShieldedAddress(), randomShieldedAddress(), randomShieldedAddress()],
    received: (address, tokenType) => receipts.get(`${address}|${tokenType}`) ?? 0n,
  };
}
