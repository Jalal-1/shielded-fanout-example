// The one witness the token contract asks for, and the private state behind it.
//
// A witness is private input that the contract reads while a proof is being
// made. It never goes on chain. This file also runs in the browser, so it must
// not import any `node:*` module.
import type { WitnessContext } from '@midnight-ntwrk/midnight-js-protocol/v9/compact-runtime';
import type { Ledger } from './managed/FanoutToken/contract/index.js';

/**
 * What the owner keeps to themselves.
 *
 * The contract stores a commitment to `hash(owner coin public key, secretNonce)`.
 * To mint, the caller must supply the same nonce again, so whoever holds this
 * nonce (and knows the owner's public key) can mint. Lose it and nobody can.
 */
export type FanoutTokenPrivateState = {
  readonly secretNonce: Uint8Array;
};

// The property name and return shape match the generated `Witnesses` type in
// managed/FanoutToken/contract/index.d.ts: [next private state, value].
export const witnesses = {
  wit_secretNonce: ({
    privateState,
  }: WitnessContext<Ledger, FanoutTokenPrivateState>): [FanoutTokenPrivateState, Uint8Array] => [
    privateState,
    privateState.secretNonce,
  ],
};
