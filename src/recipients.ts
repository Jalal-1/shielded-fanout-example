// Test recipients: a batch of shielded wallets made from one recovery phrase.
//
// To try a payout you need somebody to pay. This makes as many wallets as you
// ask for, all from one 24-word phrase by standard HD derivation (account 0,
// role Zswap, key 0, 1, 2, ...), and it can then check on chain what each of
// them received.
//
// The check works because the page holds the recipients' keys. A shielded
// payment is encrypted to its recipient, so only the recipient's keys can open
// it: the check takes a payout transaction and tries it with the key of every
// wallet that transaction was meant to pay. scripts/check-recipients.mjs does
// the same from a terminal.
import { Transaction, ZswapLocalState, ZswapSecretKeys } from '@midnight-ntwrk/midnight-js-protocol/v9';
import {
  HDWallet,
  MidnightBech32m,
  Roles,
  ShieldedAddress,
  ShieldedCoinPublicKey,
  ShieldedEncryptionPublicKey,
  generateMnemonicWords,
  joinMnemonicWords,
} from 'fanout-wallet-sdk';
import { NETWORK_ID } from './network';

/** The phrase behind the test wallets, and how many of them have been asked for so far. */
export interface TestRecipients {
  readonly mnemonic: string;
  readonly count: number;
}

/** One test wallet: where to pay it, and the keys that can see what it was paid. */
export interface Recipient {
  readonly address: string;
  readonly keys: ZswapSecretKeys;
}

// The phrase is kept in this browser, per network, so the check still works
// after a reload. Like the wallet's own seed it is stored unencrypted.
const STORAGE_KEY = `shielded-fanout:test-recipients:${NETWORK_ID}`;

export function loadTestRecipients(): TestRecipients | null {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null') as TestRecipients | null;
    return stored && typeof stored.mnemonic === 'string' && stored.count > 0 ? stored : null;
  } catch {
    return null;
  }
}

/** Remember that `count` test wallets are wanted, with a new phrase if there is none yet. */
export function saveTestRecipients(count: number, previous: TestRecipients | null): TestRecipients {
  const next: TestRecipients = {
    mnemonic: previous?.mnemonic ?? joinMnemonicWords(generateMnemonicWords()),
    count: Math.max(count, previous?.count ?? 0),
  };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  return next;
}

export const forgetTestRecipients = (): void => localStorage.removeItem(STORAGE_KEY);

/** BIP-39: a phrase becomes a seed by PBKDF2-HMAC-SHA512 of the words, salt "mnemonic", 2048 rounds. */
async function seedOf(mnemonic: string): Promise<Uint8Array> {
  const text = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', text.encode(mnemonic.normalize('NFKD')), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-512', salt: text.encode('mnemonic'), iterations: 2048 },
    key,
    512,
  );
  return new Uint8Array(bits);
}

/** Let the page draw between two pieces of work. */
const breathe = (): Promise<void> => new Promise((resolve) => setTimeout(resolve));

/**
 * The first `count` wallets of a phrase, in order.
 *
 * @param onProgress Called now and then with how many are done: a few thousand take some seconds.
 */
export async function deriveRecipients(
  mnemonic: string,
  count: number,
  onProgress?: (done: number) => void,
): Promise<Recipient[]> {
  const hd = HDWallet.fromSeed(await seedOf(mnemonic));
  if (hd.type !== 'seedOk') throw new Error('That recovery phrase is not valid.');
  const role = hd.hdWallet.selectAccount(0).selectRole(Roles.Zswap);
  const recipients: Recipient[] = [];
  for (let index = 0; recipients.length < count; index++) {
    const derived = role.deriveKeyAt(index);
    // A very few indices give no valid key. They are skipped, as every HD wallet does.
    if (derived.type === 'keyOutOfBounds') continue;
    const keys = ZswapSecretKeys.fromSeed(derived.key);
    const address = MidnightBech32m.encode(
      NETWORK_ID,
      new ShieldedAddress(
        ShieldedCoinPublicKey.fromHexString(keys.coinPublicKey),
        ShieldedEncryptionPublicKey.fromHexString(keys.encryptionPublicKey),
      ),
    ).asString();
    recipients.push({ address, keys });
    if (recipients.length % 50 === 0) {
      onProgress?.(recipients.length);
      await breathe();
    }
  }
  return recipients;
}

/**
 * How much of `tokenType` one transaction paid to each of `recipients`.
 *
 * Each wallet's keys are tried on the transaction's shielded offers, starting
 * from an empty wallet state: whatever coins that state holds afterwards were
 * paid to those keys. This is the slow part, about 0.15 seconds per wallet for
 * a 64-recipient transaction, because every output is tried.
 *
 * @param rawHex     The transaction as the indexer serves it.
 * @param onChecked  Called after each wallet with what it received.
 */
export async function receivedFrom(
  rawHex: string,
  recipients: readonly Recipient[],
  tokenType: string,
  onChecked: (recipient: Recipient, amount: bigint) => void,
  cancelled: () => boolean = () => false,
): Promise<void> {
  const bytes = Uint8Array.from(rawHex.match(/../g) ?? [], (pair) => parseInt(pair, 16));
  const transaction = Transaction.deserialize('signature', 'proof', 'binding', bytes);
  const offers = [transaction.guaranteedOffer, ...(transaction.fallibleOffer?.values() ?? [])].filter(
    (offer) => offer !== undefined,
  );
  for (const recipient of recipients) {
    if (cancelled()) return;
    let amount = 0n;
    for (const offer of offers) {
      for (const coin of new ZswapLocalState().apply(recipient.keys, offer).coins) {
        if (coin.type === tokenType) amount += coin.value;
      }
    }
    onChecked(recipient, amount);
    await breathe();
  }
}
