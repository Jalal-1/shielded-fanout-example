// Which Midnight network the app is on, and where it finds it.
//
// The chain is read and written through Blockfrost, which wants a project ID
// on every request. The page never holds that ID. It talks to its own origin
// (/chain/<network>/...), and the server behind the page adds the ID and
// passes the request on: vite.config.ts does that in development,
// deploy/nginx.conf.template on the hosted site.
//
// Proofs are made by a proof server you run yourself (`pnpm proof:up`).
import type { Endpoints } from './wallet/sdk-wallet';

export type NetworkId = 'preprod' | 'preview' | 'mainnet';

export interface Network {
  readonly id: NetworkId;
  readonly label: string;
  /** Where test NIGHT comes from. Mainnet has no faucet. */
  readonly faucet?: string;
  /** True where the tokens are worth something. */
  readonly realFunds: boolean;
}

export const NETWORKS: Readonly<Record<NetworkId, Network>> = {
  preprod: { id: 'preprod', label: 'Preprod', faucet: 'https://midnight-tmnight-preprod.nethermind.dev/', realFunds: false },
  preview: { id: 'preview', label: 'Preview', faucet: 'https://midnight-tmnight-preview.nethermind.dev/', realFunds: false },
  mainnet: { id: 'mainnet', label: 'Mainnet', realFunds: true },
};

const CHOICE_KEY = 'shielded-fanout:network';

function chosenNetwork(): NetworkId {
  // Outside a browser (the unit tests) there is nothing stored: use Preprod.
  const stored = typeof localStorage === 'undefined' ? null : localStorage.getItem(CHOICE_KEY);
  return stored !== null && stored in NETWORKS ? (stored as NetworkId) : 'preprod';
}

/**
 * The network this page is on. It is fixed for the life of the page: the
 * wallet, its saved state and the token contract all belong to one network, so
 * changing it reloads the page (see `switchNetwork`).
 */
export const NETWORK: Network = NETWORKS[chosenNetwork()];
export const NETWORK_ID: NetworkId = NETWORK.id;

/** What the fee token and its source are called here: tNIGHT and tDUST on the test networks. */
export const NIGHT = NETWORK.realFunds ? 'NIGHT' : 'tNIGHT';
export const DUST = NETWORK.realFunds ? 'DUST' : 'tDUST';

/** Move to another network. Each network has its own wallet and its own token. */
export function switchNetwork(id: NetworkId): void {
  localStorage.setItem(CHOICE_KEY, id);
  window.location.reload();
}

export const DEFAULT_PROOF_SERVER = import.meta.env.VITE_PROOF_SERVER_URL?.trim() || 'http://127.0.0.1:6300';

/** The chain through this page's own origin, and the proof server directly. */
export function chainEndpoints(proofServer: string): Endpoints {
  const { protocol, host } = window.location;
  const webSocket = protocol === 'https:' ? 'wss:' : 'ws:';
  const chain = `${host}/chain/${NETWORK_ID}`;
  return {
    networkId: NETWORK_ID,
    indexer: `${protocol}//${chain}/indexer`,
    indexerWS: `${webSocket}//${chain}/indexer/ws`,
    nodeWS: `${webSocket}//${chain}/node`,
    proofServer,
  };
}
