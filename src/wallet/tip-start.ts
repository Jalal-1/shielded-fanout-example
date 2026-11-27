// Starting a NEW wallet where the chain is now, instead of reading its history.
//
// A shielded wallet finds its coins by trying its key on every shielded coin
// the network has ever created. For a wallet restored from a seed that is the
// only way to learn what it owns, and on Preprod it takes about six minutes in
// a browser. A wallet whose seed was generated a moment ago cannot own any of
// those coins, so it has nothing to look for: all it needs from the past is
// the shape of the coin tree, so that the coins it receives later land in the
// right place and can be proven to exist.
//
// The indexer serves exactly that, a "collapsed update": the hashes that stand
// for a whole range of the tree, a few hundred bytes for all of it. This file
// asks for the tree up to the newest coin and notes the position in the
// indexer's event timeline that goes with it. sdk-wallet.ts puts the two into
// the wallet's saved state, and the wallet SDK carries on from there exactly
// as it would after a full sync.
//
// Checked against the SDK's own sync on Preprod: started this way at a point
// before a known payment, a wallet found the same coin, at the same place in
// the tree, as a wallet that read the whole history.
import { Event as LedgerEvent, MerkleTreeCollapsedUpdate, ZswapLocalState } from '@midnight-ntwrk/midnight-js-protocol/v9';
import type { Endpoints } from './sdk-wallet';

/** The shielded coin tree as it stands, ready to be a wallet's starting state. */
export interface ShieldedTip {
  /** A wallet state holding no coins, with the tree collapsed up to the newest coin. Hex. */
  readonly stateHex: string;
  /** The newest event in the indexer's shielded timeline: where the wallet's sync resumes. */
  readonly eventId: number;
  /** The protocol version the tree was read under. */
  readonly protocolVersion: number;
}

/** One entry of the indexer's shielded event timeline. */
interface TimelineEvent {
  readonly id: number;
  readonly raw: string;
  /** The newest event's id at the time this one was sent. */
  readonly maxId: number;
}

const hexToBytes = (hex: string): Uint8Array => Uint8Array.from(hex.match(/../g) ?? [], (pair) => parseInt(pair, 16));
const bytesToHex = (bytes: Uint8Array): string => Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');

/**
 * Shielded events from the indexer, starting at `fromId` (`null`: the very
 * first), until `enough` says so or nothing arrives for a while. Event ids are
 * shared with other kinds of event, so they have gaps.
 */
function timeline(
  indexerWS: string,
  fromId: number | null,
  enough: (event: TimelineEvent) => boolean,
  quietMs = 6_000,
): Promise<TimelineEvent[]> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(indexerWS, 'graphql-transport-ws');
    const received: TimelineEvent[] = [];
    let quiet: ReturnType<typeof setTimeout>;
    const finish = () => {
      clearTimeout(quiet);
      socket.close();
      resolve(received);
    };
    const waitALittle = () => {
      clearTimeout(quiet);
      quiet = setTimeout(finish, quietMs);
    };
    socket.onopen = () => socket.send(JSON.stringify({ type: 'connection_init' }));
    socket.onerror = () => reject(new Error('The indexer closed the connection.'));
    socket.onmessage = (message) => {
      const frame = JSON.parse(String(message.data)) as {
        type: string;
        payload?: { data?: { zswapLedgerEvents: TimelineEvent }; errors?: unknown };
      };
      if (frame.type === 'connection_ack') {
        socket.send(
          JSON.stringify({
            id: '1',
            type: 'subscribe',
            payload: {
              query: 'subscription ($id: Int) { zswapLedgerEvents(id: $id) { id raw maxId } }',
              variables: { id: fromId },
            },
          }),
        );
        waitALittle();
      } else if (frame.type === 'next' && frame.payload?.data) {
        const event = frame.payload.data.zswapLedgerEvents;
        received.push(event);
        if (enough(event)) finish();
        else waitALittle();
      } else if (frame.type === 'error' || frame.payload?.errors) {
        clearTimeout(quiet);
        socket.close();
        reject(new Error('The indexer refused the event subscription.'));
      }
    };
  });
}

/**
 * Where the shielded coin tree stands now, or `null` when that cannot be
 * established, in which case the wallet simply reads the history as usual.
 */
export async function shieldedTip(endpoints: Endpoints): Promise<ShieldedTip | null> {
  // 1. The newest event. Every event the indexer sends carries the newest id.
  const [first] = await timeline(endpoints.indexerWS, null, () => true);
  if (!first) return null; // no shielded event yet on this network: nothing to skip
  const tip = first.maxId;

  // 2. The newest coin at or before that event. A coin's event says where in
  //    the tree it sits. Usually the newest event is one; if not, look back.
  let newestCoin: bigint | undefined;
  for (const reach of [0, 2_000, 50_000, 1_000_000]) {
    const events = await timeline(endpoints.indexerWS, Math.max(0, tip - reach), (event) => event.id >= tip);
    for (const event of events) {
      if (event.id > tip) continue;
      const content = LedgerEvent.deserialize(hexToBytes(event.raw)).content as { tag: string; mtIndex?: bigint };
      if (content.tag === 'zswapOutput' && content.mtIndex !== undefined) newestCoin = content.mtIndex;
    }
    if (newestCoin !== undefined) break;
  }
  if (newestCoin === undefined) return null;

  // 3. The tree up to and including that coin, collapsed.
  const response = await fetch(endpoints.indexer, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      query: `{ zswapMerkleTreeCollapsedUpdate(startIndex: 0, endIndex: ${newestCoin}) { update protocolVersion } }`,
    }),
    signal: AbortSignal.timeout(20_000),
  });
  const body = (await response.json()) as {
    data?: { zswapMerkleTreeCollapsedUpdate?: { update: string; protocolVersion: number } };
  };
  const collapsed = body.data?.zswapMerkleTreeCollapsedUpdate;
  if (!response.ok || !collapsed) return null;

  // 4. An empty wallet state fast-forwarded over it. Its next free place must
  //    be the one right after the newest coin, or the pieces do not belong together.
  const state = new ZswapLocalState().applyCollapsedUpdate(MerkleTreeCollapsedUpdate.deserialize(hexToBytes(collapsed.update)));
  if (state.firstFree !== newestCoin + 1n) return null;
  return { stateHex: bytesToHex(state.serialize()), eventId: tip, protocolVersion: collapsed.protocolVersion };
}
