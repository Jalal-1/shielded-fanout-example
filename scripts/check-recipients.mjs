// Check what a set of receiving wallets was paid, straight from the chain.
//
// A shielded payment is encrypted to its recipient: only the recipient's keys
// can open it. So this script takes the recipients' secret (one mnemonic or
// seed, from which every recipient key is derived), fetches transactions from
// the indexer, and tries each recipient's keys on each transaction. Whatever a
// key opens was paid to that wallet. No wallet sync is needed.
//
// Trying one key on one 64-recipient payout takes about 0.15 seconds, so the
// work is spread over several processor threads: 2,000 keys against 32
// payouts is about 64,000 tries. By default it uses half the threads, to leave
// room for a proof server on the same machine; do not run it during a payout.
//
//   node scripts/check-recipients.mjs --mnemonic-file recipients.mnemonic
//   node scripts/check-recipients.mjs --seed-file recipients.seed --count 64
//   node scripts/check-recipients.mjs --mnemonic-file m.txt --tx <hash> --tx <hash>
//   node scripts/check-recipients.mjs --mnemonic-file m.txt --count 2000 --list 1 > pay.txt
//
// Options
//   --mnemonic-file F   24 words: recipients are account 0, role Zswap, key 0..count-1
//   --seed-file F       the same, from a hex seed instead of words
//   --count N           how many recipient keys to derive (default 64)
//   --tx HASH           check this transaction (repeatable); otherwise scan blocks
//   --blocks N          scan the last N blocks (default 600, about an hour)
//   --from-block H      or scan from this block height to the tip
//   --decimals D        show amounts with D decimal places (default 0: raw units)
//   --threads N         how many processor threads to use (default: half of them)
//   --all               print the row of every wallet, even for more than 100 wallets
//   --list AMOUNT       only print "address AMOUNT" for every recipient (a list to
//                       paste into the app) and stop, without reading the chain
//
//   --network NAME      preprod (the default), preview or mainnet
//
// Reading the chain needs that network's Blockfrost project ID in .env or the
// environment: BLOCKFROST_PREPROD_ID, BLOCKFROST_PREVIEW_ID or BLOCKFROST_MAINNET_ID.
import { pbkdf2Sync } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { Transaction, ZswapLocalState, ZswapSecretKeys } from '@midnightntwrk/ledger-v9';
import {
  HDWallet,
  MidnightBech32m,
  Roles,
  ShieldedAddress,
  ShieldedCoinPublicKey,
  ShieldedEncryptionPublicKey,
  validateMnemonic,
} from '@midnightntwrk/wallet-sdk';

/** Every offer of a transaction that creates coins. Only those can pay anybody; most transactions have none. */
function payingOffers(raw) {
  let parsed;
  try {
    parsed = Transaction.deserialize('signature', 'proof', 'binding', Buffer.from(raw, 'hex'));
  } catch {
    return []; // not a standard transaction
  }
  return [parsed.guaranteedOffer, ...(parsed.fallibleOffer?.values() ?? [])].filter(
    (offer) => offer && (offer.outputs?.length ?? 1) > 0,
  );
}

// ---- a worker thread: try its share of the keys on every transaction --------
if (!isMainThread) {
  const keys = workerData.keys.map(({ index, key }) => ({ index, keys: ZswapSecretKeys.fromSeed(key) }));
  for (const tx of workerData.txs) {
    const hits = [];
    for (const offer of payingOffers(tx.raw)) {
      for (const recipient of keys) {
        // A fresh, empty wallet state: whatever it holds after applying the offer was paid to these keys.
        for (const coin of new ZswapLocalState().apply(recipient.keys, offer).coins)
          hits.push({ index: recipient.index, tx: tx.hash, height: tx.height, type: coin.type, value: coin.value });
      }
    }
    parentPort.postMessage({ hits, tries: keys.length });
  }
  process.exit(0);
}


// ---- arguments -------------------------------------------------------------
const args = process.argv.slice(2);
const option = (name) => {
  const at = args.indexOf(`--${name}`);
  return at === -1 ? undefined : args[at + 1];
};
const options = (name) => args.flatMap((arg, at) => (arg === `--${name}` ? [args[at + 1]] : []));
const NETWORK = option('network') ?? 'preprod';
if (!['preprod', 'preview', 'mainnet'].includes(NETWORK)) throw new Error('--network is preprod, preview or mainnet.');
const INDEXER = `https://midnight-${NETWORK}.blockfrost.io/api/v0`;
const PROJECT_ID_NAME = `BLOCKFROST_${NETWORK.toUpperCase()}_ID`;
const count = Number(option('count') ?? 64);
const decimals = Number(option('decimals') ?? 0);

// ---- the recipients' keys --------------------------------------------------
function masterSeed() {
  const mnemonicFile = option('mnemonic-file');
  const seedFile = option('seed-file');
  if (mnemonicFile) {
    const mnemonic = readFileSync(mnemonicFile, 'utf8').trim().split(/\s+/).join(' ');
    if (!validateMnemonic(mnemonic)) throw new Error('That file does not hold a valid mnemonic.');
    // BIP-39, the standard words-to-seed step: PBKDF2-HMAC-SHA512 of the words,
    // salt "mnemonic", 2048 rounds, 64 bytes. No passphrase.
    return pbkdf2Sync(mnemonic.normalize('NFKD'), 'mnemonic', 2048, 64, 'sha512');
  }
  if (seedFile) return Buffer.from(readFileSync(seedFile, 'utf8').trim(), 'hex');
  throw new Error('Give --mnemonic-file or --seed-file.');
}

const hd = HDWallet.fromSeed(masterSeed());
if (hd.type !== 'seedOk') throw new Error('That seed is not valid.');
const role = hd.hdWallet.selectAccount(0).selectRole(Roles.Zswap);
const recipients = [];
for (let index = 0; recipients.length < count; index++) {
  const derived = role.deriveKeyAt(index);
  if (derived.type === 'keyOutOfBounds') continue;
  const keys = ZswapSecretKeys.fromSeed(derived.key);
  const address = MidnightBech32m.encode(
    NETWORK,
    new ShieldedAddress(
      ShieldedCoinPublicKey.fromHexString(keys.coinPublicKey),
      ShieldedEncryptionPublicKey.fromHexString(keys.encryptionPublicKey),
    ),
  ).asString();
  recipients.push({ index, address, key: derived.key, received: [] });
}

if (option('list') !== undefined) {
  console.log(recipients.map((recipient) => `${recipient.address} ${option('list')}`).join('\n'));
  process.exit(0);
}

// ---- the chain -------------------------------------------------------------
const projectId =
  process.env[PROJECT_ID_NAME] ??
  (existsSync('.env') ? (readFileSync('.env', 'utf8').match(new RegExp(`^${PROJECT_ID_NAME}=(\\S+)`, 'm')) ?? [])[1] : undefined);
if (!projectId) throw new Error(`Set ${PROJECT_ID_NAME} in .env or the environment.`);
async function indexer(query) {
  for (let attempt = 1; ; attempt++) {
    try {
      const response = await fetch(INDEXER, {
        method: 'POST',
        headers: { 'content-type': 'application/json', project_id: projectId },
        body: JSON.stringify({ query }),
      });
      const body = await response.json();
      if (body.errors) throw new Error(body.errors[0].message);
      return body.data;
    } catch (error) {
      if (attempt >= 4) throw error;
      await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
    }
  }
}

/** Every transaction to check, as { hash, height, raw }. */
async function transactions() {
  const hashes = options('tx');
  if (hashes.length > 0) {
    const found = [];
    for (const hash of hashes) {
      const data = await indexer(`{ transactions(offset: {hash: "${hash}"}) { hash raw block { height } } }`);
      for (const tx of data.transactions) found.push({ hash: tx.hash, height: tx.block.height, raw: tx.raw });
    }
    return found;
  }
  const tip = (await indexer('{ block { height } }')).block.height;
  const from = Number(option('from-block') ?? tip - Number(option('blocks') ?? 600));
  console.log(`Scanning blocks ${from} to ${tip} on ${NETWORK}…`);
  const found = [];
  let next = from;
  const worker = async () => {
    while (next <= tip) {
      const height = next++;
      const data = await indexer(`{ block(offset: {height: ${height}}) { transactions { hash raw } } }`);
      for (const tx of data.block?.transactions ?? []) found.push({ hash: tx.hash, height, raw: tx.raw });
    }
  };
  await Promise.all(Array.from({ length: 8 }, worker));
  return found.sort((a, b) => a.height - b.height);
}

// ---- open each transaction with each recipient's keys ----------------------
const show = (value) => {
  if (decimals === 0) return String(value);
  const text = String(value).padStart(decimals + 1, '0');
  return `${text.slice(0, -decimals)}.${text.slice(-decimals)}`.replace(/\.?0+$/, '');
};

// Only transactions that create shielded coins need trying.
const txs = await transactions();
const candidates = txs.filter((tx) => payingOffers(tx.raw).length > 0);
const threads = Math.max(
  1,
  Math.min(Number(option('threads') ?? Math.ceil(availableParallelism() / 2)), recipients.length),
);
const total = candidates.length * recipients.length;
console.log(
  `Trying ${recipients.length} keys on ${candidates.length} transactions that create shielded coins (of ${txs.length}), on ${threads} threads…`,
);

const hitsByTx = new Map();
let tried = 0;
let lastShown = 0;
await Promise.all(
  Array.from({ length: threads }, (_, thread) => {
    const share = recipients.filter((_, at) => at % threads === thread).map(({ index, key }) => ({ index, key }));
    return new Promise((resolve, reject) => {
      const worker = new Worker(new URL(import.meta.url), { workerData: { keys: share, txs: candidates } });
      worker.on('message', ({ hits, tries }) => {
        for (const hit of hits) {
          recipients.find((recipient) => recipient.index === hit.index).received.push(hit);
          hitsByTx.set(hit.tx, (hitsByTx.get(hit.tx) ?? 0) + 1);
        }
        tried += tries;
        if (process.stderr.isTTY && Date.now() - lastShown > 1000) {
          lastShown = Date.now();
          process.stderr.write(`\r  ${Math.floor((tried * 100) / Math.max(1, total))}% `);
        }
      });
      worker.on('error', reject);
      worker.on('exit', resolve);
    });
  }),
);
if (process.stderr.isTTY) process.stderr.write('\r        \r');

for (const tx of candidates) {
  const hits = hitsByTx.get(tx.hash) ?? 0;
  if (hits > 0) console.log(`  block ${tx.height}  tx ${tx.hash}  pays ${hits} of these ${recipients.length} wallets`);
}
const paying = hitsByTx.size;

// ---- report ----------------------------------------------------------------
console.log(`\nChecked ${txs.length} transactions; ${paying} of them pay these wallets.\n`);
const totalsOf = (recipient) => {
  const totals = new Map();
  for (const coin of recipient.received) totals.set(coin.type, (totals.get(coin.type) ?? 0n) + coin.value);
  return [...totals].map(([type, value]) => `${show(value)} of ${type.slice(0, 10)}…`).join(', ') || '-';
};
const paid = recipients.filter((recipient) => recipient.received.length > 0).length;
if (recipients.length <= 100 || args.includes('--all')) {
  console.log(' key  payments  total received by token                       address');
  for (const recipient of recipients) {
    console.log(
      `${String(recipient.index).padStart(4)}  ${String(recipient.received.length).padStart(8)}  ${totalsOf(recipient).padEnd(44)}  ${recipient.address.slice(0, 34)}…${recipient.address.slice(-6)}`,
    );
  }
} else {
  // Too many for a row each: say how many wallets got what, and which got nothing.
  const groups = new Map();
  for (const recipient of recipients) {
    const what = `${recipient.received.length} ${recipient.received.length === 1 ? 'payment' : 'payments'}, ${totalsOf(recipient)}`;
    groups.set(what, [...(groups.get(what) ?? []), recipient.index]);
  }
  // 0,1,2,5,6 becomes "0-2, 5-6".
  const ranges = (indices) =>
    indices
      .reduce((runs, index) => {
        const last = runs.at(-1);
        if (last && last[1] === index - 1) last[1] = index;
        else runs.push([index, index]);
        return runs;
      }, [])
      .map(([from, to]) => (from === to ? `${from}` : `${from}-${to}`))
      .join(', ');
  for (const [what, indices] of groups) console.log(`${String(indices.length).padStart(5)} wallets: ${what}   (keys ${ranges(indices)})`);
}
console.log(`\n${paid} of ${recipients.length} wallets were paid.`);
process.exit(0);
