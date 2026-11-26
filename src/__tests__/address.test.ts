import { describe, expect, it } from 'vitest';
import { bech32m } from '@scure/base';
import {
  MidnightBech32m,
  ShieldedAddress,
  ShieldedCoinPublicKey,
  ShieldedEncryptionPublicKey,
  UnshieldedAddress,
} from '@midnightntwrk/wallet-sdk-address-format';
import { checkShieldedAddress } from '../address';

const bytes = (length: number, fill: number): Buffer => Buffer.alloc(length, fill);

// Addresses made by the wallet SDK's own codec, so the check is tested against
// the real format and not against this project's idea of it.
const shielded = (networkId: string): string =>
  MidnightBech32m.encode(
    networkId,
    new ShieldedAddress(new ShieldedCoinPublicKey(bytes(32, 1)), new ShieldedEncryptionPublicKey(bytes(32, 2))),
  ).asString();

describe('checkShieldedAddress', () => {
  it('accepts a Preprod shielded address made by the wallet SDK', () => {
    const address = shielded('preprod');
    expect(address.startsWith('mn_shield-addr_preprod1')).toBe(true);
    expect(checkShieldedAddress(address, 'preprod')).toBeNull();
    expect(checkShieldedAddress(`  ${address}  `, 'preprod')).toBeNull();
  });

  it('rejects a shielded address for another network', () => {
    expect(checkShieldedAddress(shielded('preview'), 'preprod')).toMatch(/another network/);
  });

  it('rejects an unshielded address', () => {
    const unshielded = MidnightBech32m.encode('preprod', new UnshieldedAddress(bytes(32, 3))).asString();
    expect(checkShieldedAddress(unshielded, 'preprod')).toMatch(/not a shielded address/);
  });

  it('rejects typos, empty text and other formats', () => {
    const address = shielded('preprod');
    const typo = address.slice(0, -1) + (address.endsWith('q') ? 'p' : 'q');
    expect(checkShieldedAddress(typo, 'preprod')).toMatch(/not a valid address/);
    expect(checkShieldedAddress('', 'preprod')).toMatch(/Enter/);
    expect(checkShieldedAddress('hello', 'preprod')).toMatch(/not a valid address/);
  });

  it('rejects a payload of the wrong length', () => {
    const short = bech32m.encode('mn_shield-addr_preprod', bech32m.toWords(new Uint8Array(32)), false);
    expect(checkShieldedAddress(short, 'preprod')).toMatch(/wrong length/);
  });
});
