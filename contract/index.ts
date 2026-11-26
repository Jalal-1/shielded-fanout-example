// The compiled token contract, ready for Midnight.js.
//
// `pnpm compile` writes the compiler output to contract/managed/FanoutToken.
// That folder is committed, so running the app needs no Compact compiler.
// This file also runs in the browser, so it must not import any `node:*` module.
import { CompiledContract } from '@midnight-ntwrk/midnight-js-protocol/v9/compact-js';
import { Contract } from './managed/FanoutToken/contract/index.js';
import type { ProvableCircuits } from './managed/FanoutToken/contract/index.js';
import { witnesses, type FanoutTokenPrivateState } from './witnesses.js';

export { Contract, ledger, pureCircuits, type Ledger } from './managed/FanoutToken/contract/index.js';
export { witnesses, type FanoutTokenPrivateState } from './witnesses.js';

/** The contract with this app's private state filled in. */
export type FanoutTokenContract = Contract<FanoutTokenPrivateState>;

/** The names of the circuits that need a proof: "mint", "burn", and so on. */
export type FanoutTokenCircuits = keyof ProvableCircuits<FanoutTokenPrivateState>;

export const CompiledFanoutToken = CompiledContract.make<FanoutTokenContract>('FanoutToken', Contract).pipe(
  CompiledContract.withWitnesses(witnesses),
  CompiledContract.withCompiledFileAssets('./managed/FanoutToken'),
);
