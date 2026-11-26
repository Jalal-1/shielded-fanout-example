// An in-memory private-state store for Midnight.js.
//
// Midnight.js keeps a contract's private state (here: the owner's secret nonce)
// in a "private state provider". This one lives only as long as the page. The
// secret itself is kept in localStorage by src/storage.ts, and the state is
// rebuilt from it after a reload. Same approach as the official leaderboard
// example in github.com/midnightntwrk/midnight-examples.
import type { ContractAddress, SigningKey } from '@midnight-ntwrk/midnight-js-protocol/v9/compact-runtime';
import type { ContractPrivateStates, PrivateStateId, PrivateStateProvider } from '@midnight-ntwrk/midnight-js-types';
import { assertIsContractAddress } from '@midnight-ntwrk/midnight-js-utils';

export function inMemoryPrivateStateProvider<PSI extends PrivateStateId, PS>(): PrivateStateProvider<PSI, PS> {
  const states = new Map<ContractAddress, Map<PSI, PS>>();
  const signingKeys = new Map<ContractAddress, SigningKey>();
  const unsupported = (method: string) => async (): Promise<never> => {
    throw new Error(`${method} is not supported by the in-memory private state provider`);
  };

  const forContract = (address: ContractAddress): ContractPrivateStates<PSI, PS> => {
    assertIsContractAddress(address);
    const contractAddress = address.toLowerCase();
    return {
      contractAddress,
      async set(id: PSI, state: PS) {
        const scoped = states.get(contractAddress) ?? new Map<PSI, PS>();
        scoped.set(id, state);
        states.set(contractAddress, scoped);
      },
      async get(id: PSI) {
        return states.get(contractAddress)?.get(id) ?? null;
      },
      async remove(id: PSI) {
        states.get(contractAddress)?.delete(id);
      },
      async clear() {
        states.delete(contractAddress);
      },
      exportPrivateStates: unsupported('exportPrivateStates'),
      importPrivateStates: unsupported('importPrivateStates'),
    };
  };

  return {
    forContract,
    async clearAll() {
      states.clear();
    },
    async setSigningKey(address: ContractAddress, signingKey: SigningKey) {
      signingKeys.set(address, signingKey);
    },
    async getSigningKey(address: ContractAddress) {
      return signingKeys.get(address) ?? null;
    },
    async removeSigningKey(address: ContractAddress) {
      signingKeys.delete(address);
    },
    async clearSigningKeys() {
      signingKeys.clear();
    },
    exportSigningKeys: unsupported('exportSigningKeys'),
    importSigningKeys: unsupported('importSigningKeys'),
  };
}
