// Runs the real Midnight.js deploy with a stub wallet and a stub indexer.
//
// Without a chain the deploy cannot finish, but it gets a long way: the module
// loads (WebAssembly included), the wallet's Bech32m keys are understood, the
// contract's constructor runs, the verifier keys are fetched from the site and
// checked, and a deploy transaction is handed to the wallet. The stub wallet
// declines it there, the way a user could.
import { readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Transaction, ZswapSecretKeys } from '@midnight-ntwrk/midnight-js-protocol/v9';
import {
  MidnightBech32m,
  ShieldedAddress,
  ShieldedCoinPublicKey,
  ShieldedEncryptionPublicKey,
} from '@midnightntwrk/wallet-sdk-address-format';
import type { ConnectedAPI } from '@midnight-ntwrk/dapp-connector-api';
import { createRealBackend } from '../midnight/real-backend';
import { explainError, type Session } from '../wallet';

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');

const MANAGED = path.resolve(import.meta.dirname, '../../contract/managed/FanoutToken');
const SITE = 'http://localhost:3000/';
let siteRequests: string[];

/** Stands in for the site: serves the compiler output from disk. */
async function serveSiteFiles(input: RequestInfo | URL): Promise<Response> {
  const { pathname } = new URL(String(input));
  siteRequests.push(pathname);
  try {
    return new Response(await readFile(path.join(MANAGED, pathname)), { status: 200 });
  } catch {
    return new Response('not found', { status: 404 });
  }
}

let indexer: Server;
let indexerQueries: string[];

beforeEach(async () => {
  indexerQueries = [];
  indexer = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => (body += chunk));
    request.on('end', () => {
      const { operationName } = JSON.parse(body) as { operationName: string };
      indexerQueries.push(operationName);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify(
          // The one question a deploy asks first: which ledger is the chain on?
          // Protocol version 2.x means Ledger 9.
          operationName === 'HEAD_PROTOCOL_VERSION_QUERY'
            ? { data: { block: { protocolVersion: 2_001_100, __typename: 'Block' } } }
            : { errors: [{ message: 'stub indexer: no chain behind this' }] },
        ),
      );
    });
  });
  await new Promise<void>((resolve) => indexer.listen(0, '127.0.0.1', resolve));
  // The backend asks where the site is, and fetches the keys from beside it.
  siteRequests = [];
  vi.stubGlobal('location', { href: SITE });
  vi.stubGlobal('fetch', vi.fn(serveSiteFiles));
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await new Promise((resolve) => indexer.close(resolve));
});

function stubWallet() {
  const { port } = indexer.address() as AddressInfo;
  const keys = ZswapSecretKeys.fromSeed(crypto.getRandomValues(new Uint8Array(32)));
  const coinKey = new ShieldedCoinPublicKey(Buffer.from(keys.coinPublicKey, 'hex'));
  const encryptionKey = new ShieldedEncryptionPublicKey(Buffer.from(keys.encryptionPublicKey, 'hex'));
  const calls: string[] = [];
  const handedOver: string[] = [];
  const api = {
    getConfiguration: async () => ({
      indexerUri: `http://127.0.0.1:${port}/api/v4/graphql`,
      indexerWsUri: `ws://127.0.0.1:${port}/api/v4/graphql/ws`,
      substrateNodeUri: 'ws://127.0.0.1:1',
      networkId: 'preprod',
    }),
    // A real wallet reports its keys as Bech32m text, so the stub does too.
    getShieldedAddresses: async () => ({
      shieldedAddress: MidnightBech32m.encode('preprod', new ShieldedAddress(coinKey, encryptionKey)).asString(),
      shieldedCoinPublicKey: ShieldedCoinPublicKey.codec.encode('preprod', coinKey).asString(),
      shieldedEncryptionPublicKey: ShieldedEncryptionPublicKey.codec.encode('preprod', encryptionKey).asString(),
    }),
    getProvingProvider: async () => {
      calls.push('getProvingProvider');
      return { check: async () => [], prove: async () => new Uint8Array() };
    },
    balanceUnsealedTransaction: async (tx: string) => {
      calls.push('balanceUnsealedTransaction');
      handedOver.push(tx);
      throw Object.assign(new Error('User rejected'), { type: 'DAppConnectorAPIError', code: 'Rejected', reason: 'User rejected' });
    },
  } as unknown as ConnectedAPI;
  return { api, calls, handedOver };
}

describe('real backend, as far as it goes without a chain', () => {
  it('builds a deploy transaction and hands it to the wallet', async () => {
    const wallet = stubWallet();
    const session: Session = { api: wallet.api, walletName: 'Stub', ...(await wallet.api.getShieldedAddresses()) };
    expect(session.shieldedCoinPublicKey.startsWith('mn_shield-cpk_preprod1')).toBe(true);

    const secrets = { secretNonce: hex(crypto.getRandomValues(new Uint8Array(32))), instanceSalt: 'ab'.repeat(32) };
    const meta = { name: 'Fanout Demo', symbol: 'FAN', decimals: 2 };
    const failure = await createRealBackend().deployToken(session, meta, secrets).catch((error: unknown) => error);

    // The chain's ledger version came from the wallet's indexer.
    expect(indexerQueries).toEqual(['HEAD_PROTOCOL_VERSION_QUERY']);

    // A deploy carries every circuit's verifier key and needs no prover key.
    const keys = siteRequests.filter((request) => request.startsWith('/keys/'));
    expect(keys).toHaveLength(10);
    expect(keys.every((request) => request.endsWith('.verifier'))).toBe(true);
    expect(siteRequests).toContain('/compiler/contract-manifest.json');

    // The wallet received one well-formed, not yet sealed transaction.
    expect(wallet.calls).toEqual(['getProvingProvider', 'balanceUnsealedTransaction']);
    expect(wallet.handedOver).toHaveLength(1);
    const tx = Transaction.deserialize('signature', 'proof', 'pre-binding', Buffer.from(wallet.handedOver[0]!, 'hex'));
    expect(tx.identifiers().length).toBeGreaterThan(0);

    // Declining in the wallet surfaces as a plain sentence, not a stack trace.
    expect(explainError(failure)).toBe('You declined the request in your wallet. Nothing was sent.');
  });
});
