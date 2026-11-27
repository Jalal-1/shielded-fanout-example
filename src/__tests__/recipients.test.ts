import { pbkdf2Sync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { HDWallet, Roles } from 'fanout-wallet-sdk';
import { ZswapSecretKeys } from '@midnight-ntwrk/midnight-js-protocol/v9';
import { checkShieldedAddress } from '../address';
import { deriveRecipients } from '../recipients';

// The standard BIP-39 test phrase: nobody's wallet.
const PHRASE = `${'abandon '.repeat(23)}art`;

describe('test recipients', () => {
  it('derives usable, distinct addresses, the same ones every time', async () => {
    const first = await deriveRecipients(PHRASE, 5);
    const again = await deriveRecipients(PHRASE, 3);
    expect(first).toHaveLength(5);
    expect(new Set(first.map((recipient) => recipient.address)).size).toBe(5);
    for (const recipient of first) expect(checkShieldedAddress(recipient.address, 'preprod')).toBeNull();
    // A smaller batch is the start of a larger one.
    expect(again.map((recipient) => recipient.address)).toEqual(first.slice(0, 3).map((recipient) => recipient.address));
  });

  it('turns the phrase into keys the way BIP-39 and the wallet SDK say', async () => {
    // Worked out independently here: PBKDF2 by Node, then account 0, role Zswap, key 0.
    const seed = pbkdf2Sync(PHRASE.normalize('NFKD'), 'mnemonic', 2048, 64, 'sha512');
    const hd = HDWallet.fromSeed(seed);
    if (hd.type !== 'seedOk') throw new Error('seed');
    const derived = hd.hdWallet.selectAccount(0).selectRole(Roles.Zswap).deriveKeyAt(0);
    if (derived.type === 'keyOutOfBounds') throw new Error('key');
    const expected = ZswapSecretKeys.fromSeed(derived.key);

    const [recipient] = await deriveRecipients(PHRASE, 1);
    expect(recipient?.keys.coinPublicKey).toBe(expected.coinPublicKey);
    expect(recipient?.keys.encryptionPublicKey).toBe(expected.encryptionPublicKey);
  });
});
