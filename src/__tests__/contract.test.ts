// Runs the compiled token contract in memory, with no chain and no proofs.
// It checks the two things the app relies on: only the owner can mint, and the
// token type the app computes is the one the contract mints.
import { describe, expect, it } from 'vitest';
import { rawTokenType } from '@midnight-ntwrk/midnight-js-protocol/v9';
import {
  createCircuitContext,
  createConstructorContext,
  encodeCoinPublicKey,
  sampleContractAddress,
  type ChargedState,
} from '@midnight-ntwrk/midnight-js-protocol/v9/compact-runtime';
import { Contract, ledger, pureCircuits, witnesses, type FanoutTokenPrivateState } from '../../contract/index';

const bytes32 = (): Uint8Array => crypto.getRandomValues(new Uint8Array(32));
const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');

const OWNER_KEY = hex(bytes32()); // the owner's coin public key
const SECRET_NONCE = bytes32();
const DOMAIN = new Uint8Array(32).fill(7);
const ADDRESS = sampleContractAddress();

const contract = new Contract<FanoutTokenPrivateState>(witnesses);
const coinKey = (keyHex: string) => ({ bytes: encodeCoinPublicKey(keyHex) });

/** Deploy the way the app does: owner id = hash(owner coin public key, secret nonce). */
async function deploy(): Promise<ChargedState> {
  const ownerId = pureCircuits._computeOwnerId(
    { is_left: true, left: coinKey(OWNER_KEY), right: { bytes: new Uint8Array(32) } },
    SECRET_NONCE,
  );
  const result = await contract.initialState(
    createConstructorContext({ secretNonce: SECRET_NONCE }, OWNER_KEY),
    ownerId,
    bytes32(),
    DOMAIN,
    'Fanout Demo',
    'FAN',
    2n,
  );
  return result.currentContractState.data;
}

/** Call `mint` as `caller`, holding `secretNonce` as private state. */
async function mint(state: ChargedState, caller: string, secretNonce: Uint8Array, amount: bigint) {
  const context = createCircuitContext<FanoutTokenPrivateState>({
    circuitId: 'mint',
    contractAddress: ADDRESS,
    coinPublicKeyOrZswapState: caller,
    contractState: state,
    privateState: { secretNonce },
  });
  const out = await contract.impureCircuits.mint(context, coinKey(caller), amount, bytes32());
  return { coin: out.result, state: out.context.callContext.currentQueryContext.state };
}

describe('FanoutToken contract (in memory)', () => {
  it('stores the metadata given at deploy', async () => {
    const state = ledger(await deploy());
    expect(state._name).toBe('Fanout Demo');
    expect(state._symbol).toBe('FAN');
    expect(state._decimals).toBe(2n);
  });

  it('lets the owner mint, in the token type the app computes', async () => {
    const { coin } = await mint(await deploy(), OWNER_KEY, SECRET_NONCE, 10_000n);
    expect(coin.value).toBe(10_000n);
    expect(hex(coin.color)).toBe(rawTokenType(DOMAIN, ADDRESS));
  });

  it('refuses a mint from another wallet', async () => {
    const stranger = hex(bytes32());
    await expect(mint(await deploy(), stranger, SECRET_NONCE, 1n)).rejects.toThrow(/caller is not the owner/i);
  });

  it('refuses a mint from the owner wallet without the secret nonce', async () => {
    await expect(mint(await deploy(), OWNER_KEY, bytes32(), 1n)).rejects.toThrow(/caller is not the owner/i);
  });
});
