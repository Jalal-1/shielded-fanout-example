// Checking a recipient's shielded address before the wallet sees it.
//
// A Midnight shielded address is Bech32m text. Its prefix names the kind of
// address and the network, and its payload is two 32-byte public keys:
//
//   mn_shield-addr_preprod1<coin public key><encryption public key><checksum>
//
// The coin public key says who owns a coin. The encryption public key lets the
// sender encrypt the coin's details so that only the recipient can find it.
import { bech32m } from '@scure/base';

const PAYLOAD_BYTES = 64;

/** The prefix every shielded address on `networkId` starts with. */
export const shieldedAddressPrefix = (networkId: string): string => `mn_shield-addr_${networkId}`;

/** Returns `null` when the address is usable, or a sentence saying why not. */
export function checkShieldedAddress(text: string, networkId: string): string | null {
  const address = text.trim();
  if (address === '') return 'Enter a shielded address.';

  let prefix: string;
  let payloadLength: number;
  try {
    // Midnight addresses are longer than Bech32's usual 90-character limit.
    const decoded = bech32m.decode(address as `${string}1${string}`, false);
    prefix = decoded.prefix;
    payloadLength = bech32m.fromWords(decoded.words).length;
  } catch {
    return 'This is not a valid address. Check for a typo or a missing character.';
  }

  const expected = shieldedAddressPrefix(networkId);
  if (prefix !== expected) {
    if (prefix.startsWith('mn_shield-addr')) return `This shielded address is for another network. It must start with ${expected}1.`;
    if (prefix.startsWith('mn_')) return `This is not a shielded address. It must start with ${expected}1.`;
    return `This is not a Midnight address. It must start with ${expected}1.`;
  }
  if (payloadLength !== PAYLOAD_BYTES) return 'This address has the wrong length.';
  return null;
}
