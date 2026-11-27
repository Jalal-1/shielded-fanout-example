// Where the in-page wallet keeps things between visits, in this browser only.
//
//   the seed          localStorage. It IS the wallet: whoever has it owns the
//                     funds. A real custodian keeps it in a vault or an HSM.
//   the sync state    IndexedDB. It is large, and only saves time: without it
//                     the wallet syncs with the chain from the start again.
//
// Each network has its own seed, so a wallet made for testing is never the
// wallet that holds real funds.
import { NETWORK_ID } from '../network';
import type { SavedWalletState } from './sdk-wallet';

const SEED_KEY = `shielded-fanout:wallet-seed:${NETWORK_ID}`;
const DB_NAME = 'shielded-fanout';
const STORE = 'wallet-state';

export const loadSeed = (): string | null => localStorage.getItem(SEED_KEY);
export const saveSeed = (seedHex: string): void => localStorage.setItem(SEED_KEY, seedHex);
export const forgetSeed = (): void => localStorage.removeItem(SEED_KEY);

/** 32 random bytes as hex: a new wallet. */
export function newSeed(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB is not available.'));
  });
}

export async function loadWalletState(key: string): Promise<SavedWalletState | undefined> {
  const db = await database();
  try {
    return await new Promise((resolve, reject) => {
      const request = db.transaction(STORE).objectStore(STORE).get(key);
      request.onsuccess = () => resolve(request.result as SavedWalletState | undefined);
      request.onerror = () => reject(request.error ?? new Error('Could not read the saved wallet state.'));
    });
  } finally {
    db.close();
  }
}

export async function saveWalletState(key: string, state: SavedWalletState): Promise<void> {
  const db = await database();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(state, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('Could not save the wallet state.'));
    });
  } finally {
    db.close();
  }
}

export async function forgetWalletState(key?: string): Promise<void> {
  const db = await database();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      if (key) tx.objectStore(STORE).delete(key);
      else tx.objectStore(STORE).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('Could not clear the wallet state.'));
    });
  } finally {
    db.close();
  }
}
