# Shielded fanout

A proof of concept for [Midnight](https://midnight.network): mint your own shielded token, then pay many shielded wallets at once. Up to 64 recipients go in **one transaction**, where either everyone is paid or nobody is. A longer list is sent as several such transactions, one after another, and the page keeps track of every line.

The wallet runs in the page, built on the official Midnight wallet SDK. It is the same code a backend service would run: there is no browser extension involved.

**Live site:** https://shielded-fanout.fly.dev

The payout itself is a dozen lines, in [`src/fanout.ts`](src/fanout.ts). The rest of the project is what it takes to get a wallet and a token to pay out with.

## Contents

- [Use the hosted site](#use-the-hosted-site)
- [Run it yourself](#run-it-yourself)
- [Using the app](#using-the-app)
- [Checking that recipients were paid](#checking-that-recipients-were-paid)
- [How the fanout works](#how-the-fanout-works)
- [What was measured](#what-was-measured)
- [Networks and the Blockfrost keys](#networks-and-the-blockfrost-keys)
- [Deploying](#deploying)
- [Project layout](#project-layout)
- [Limits](#limits)

## Use the hosted site

You need one thing on your own machine: a **proof server**. Every Midnight transaction carries zero-knowledge proofs, and whoever makes them sees the transaction's private inputs, so the site does not make them for you.

1. Start a proof server with Docker and leave it running:

   ```bash
   docker run --rm -p 127.0.0.1:6300:6300 midnightntwrk/proof-server:9.0.2 midnight-proof-server --job-capacity 1024
   ```

2. Open https://shielded-fanout.fly.dev and follow the six steps on the page.

The page reaches the proof server at `http://127.0.0.1:6300`, and browsers ask before letting a site on the internet reach your computer:

- **Chrome:** choose Allow when it asks to connect to devices on your local network, or allow it from the padlock menu in the address bar.
- **Brave:** allow the site under Settings, Privacy and security, Site and Shields settings, Localhost access.
- **Safari** does not allow it.

If the page keeps saying the proof server is not answering, that permission is the usual reason. [Running the app yourself](#run-it-yourself) avoids the question, because then the page is on your machine too.

## Run it yourself

You need:

- **Node 22** and **pnpm**.
- **Docker**, for the proof server.
- A **Blockfrost project ID** for each Midnight network you want to use, from [blockfrost.io](https://blockfrost.io). The app reads the chain and submits transactions through Blockfrost.

You do not need the Compact compiler: the compiled contract is committed.

```bash
git clone https://github.com/Jalal-1/shielded-fanout-example.git
cd shielded-fanout-example
pnpm install
cp .env.example .env
```

Put your project IDs in `.env`:

```bash
BLOCKFROST_PREPROD_ID=...
BLOCKFROST_PREVIEW_ID=...
BLOCKFROST_MAINNET_ID=...
```

Then start the proof server and the app:

```bash
pnpm proof:up
pnpm dev
```

Open http://localhost:3000.

## Using the app

The page is one screen. The panel on the left always shows what is happening, your balances and the progress of the payout. The six steps are tabs on the right.

Pick the network at the top left: **Preprod**, **Preview** or **Mainnet**. Each network has its own wallet and its own token, and switching reloads the page. Start on a test network. Mainnet uses real NIGHT, and this proof of concept keeps the wallet's seed unencrypted in the browser.

| Step | What you do |
| --- | --- |
| **1. Wallet** | Create a wallet, or restore one from its seed. A new wallet reads the chain's history once, which takes several minutes (about six on Preprod). Progress is saved, so later visits take seconds. Back up the seed. |
| **2. tNIGHT** | Copy the address shown, open the faucet, and request test tokens. On Mainnet there is no faucet: send NIGHT to the address. |
| **3. tDUST** | Press **Generate tDUST**. Fees are paid in DUST, which is not bought or sent: your NIGHT generates it over time once it is registered. Registering is one transaction and pays for itself. |
| **4. Token** | Deploy your own token contract (name, symbol, decimals), or use one already on the network by its address. Only the wallet that deployed a contract can mint it. |
| **5. Mint** | Mint an amount to your own wallet. |
| **6. Pay** | Enter who to pay, and send. |

### Paying a list

The list is plain text, one wallet per line: its shielded address, then the amount.

```text
mn_shield-addr_preprod1qz...  17
mn_shield-addr_preprod1x8...  29.5
```

Paste it into the box or load it from a text file. The page checks every line and says what a press of the button will do, for example "2,000 wallets in 32 transactions, about 24 minutes". Keep the tab open and in front while it runs.

After you start, every line has a row with its state:

| State | Meaning |
| --- | --- |
| **Paid** | Its transaction is finalized on chain. |
| **Failed, not paid** | Its transaction could not be built, or failed on chain. Nothing was paid. Safe to send again. |
| **Unconfirmed** | Its transaction was built and handed over, but the network has not reported it. Held back from sending again, so that nobody is paid twice. |
| **Not sent** | The run stopped before reaching it. |

What you can do from there:

- **Send the wallets not paid yet.** One button sends every failed and unsent line again, and never a paid one.
- **Check the unconfirmed.** Asks the network again what became of those transactions.
- **Filter** the rows by state, and see why each failed transaction failed.
- **Download the results (CSV):** every line with its state and transaction hash.
- **Stop after this transaction** ends a run cleanly.

If the page is reloaded part-way, load the same list again: the page recognizes it and continues where it stopped. Progress is stored by line number, without addresses or amounts.

## Checking that recipients were paid

A shielded payment is encrypted to its recipient, so the chain does not show who was paid. Whoever holds the recipients' keys can check. [`scripts/check-recipients.mjs`](scripts/check-recipients.mjs) derives recipient keys from one mnemonic or seed, reads transactions from the indexer, and tries each key on each transaction. No wallet sync is needed.

```bash
# Make a test list: 2,000 addresses derived from one mnemonic, 1 token each
node scripts/check-recipients.mjs --mnemonic-file recipients.mnemonic --count 2000 --list 1 > pay.txt

# After paying it: which of those wallets were paid in the last 600 blocks?
node scripts/check-recipients.mjs --mnemonic-file recipients.mnemonic --count 2000 --decimals 2
```

It reads the project ID from `.env`. Its other options are described at the top of the file: `--tx` to check single transactions, `--from-block`, `--network` and `--threads`. Do not run it during a payout on the same machine: it is processor-heavy and slows the proof server.

## How the fanout works

The payout is one wallet SDK call with one output per recipient:

```ts
// src/wallet/browser-wallet.ts
const recipe = await facade.transferTransaction(
  [
    {
      type: 'shielded',
      outputs: payments.map((payment) => ({
        type: tokenType, // the token's 32-byte type, as hex
        receiverAddress: MidnightBech32m.parse(payment.recipient).decode(ShieldedAddress, networkId),
        amount: payment.amount, // in the token's smallest unit
      })),
    },
  ],
  { ttl, payFees: true },
);
```

Inside that call the wallet:

- **selects inputs:** which of its coins to spend,
- **creates the outputs:** one new coin per recipient,
- **returns the change:** one more coin back to the sender for whatever is left over,
- **adds the fee** in DUST.

The app then signs it, has the proof server prove it, and submits it ([`src/fanout.ts`](src/fanout.ts)). Because every output is in the same transaction, the payout is atomic.

Three things to know:

- **No contract is involved in the payout.** A shielded token on Midnight is a native coin. The contract is needed to mint it. Moving it is a plain wallet transfer.
- **Transactions of a long list go one after another.** A payment spends whole coins, and the rest comes back as change that can be spent only once the transaction is finalized. So each transaction waits for the one before it.
- **A transaction is built once.** If building fails (a proof fails, a request is dropped), nothing was submitted and it is built again. Once built it is never built a second time: the network's verdict decides whether its lines were paid.

### What the chain shows

Shielded transfers hide who paid whom and how much. Some things are public:

- **That a transaction happened**, and roughly its shape, such as how many coins it created.
- **Minting.** A mint is a contract call, and the contract keeps a public running total.
- **Deploying.** The contract's address, and the name, symbol and decimals you chose.

## What was measured

On Preprod, on 26 November 2026, with the proof server on a 24-thread desktop:

| | |
| --- | --- |
| Recipients in one transaction | 64 (the largest tried, not the network's limit) |
| Size of that transaction | 343 KB |
| Selecting coins and proving | 22 to 25 seconds |
| Network finality | about 20 seconds, at times up to 65 |
| One 64-recipient transaction, start to finalized | about 44 seconds |
| Fee | about 5 tDUST per 64-recipient transaction |
| 2,000 recipients | 32 transactions, about 24 minutes when nothing goes wrong |

Worked examples on Preprod:

- **64 recipients, one transaction:** `6e7a098a6e910b857408c7f865005bcb06d8a73eff613b746bc7a4eee2ef6518` (block 3,591,504).
- **2,000 recipients, 32 transactions:** from `0253d4a9f49f2f47e1aed593fc064f56ed6550bc2eecb93631e7ae4b2da2ecf6` (block 3,593,773) to `c181bb5519e6d5d80b38233f7e60b2f21a24ecdf20aed98f303adaa2d06b4d35` (block 3,594,086). The checker confirmed that each of the 2,000 wallets received exactly one payment.

That run was interrupted once, when the page lost its connection to the proof server while proving. Nothing had been submitted, and the remaining wallets were paid by sending the unpaid lines again. Since then the page retries a transaction that could not be built by itself.

Proving time depends on the machine running the proof server. Finality depends on the network.

## Networks and the Blockfrost keys

Blockfrost wants a project ID on every request. A page that held the ID would show it to every visitor, so the page never has it. It talks to its own origin:

| The page asks | The server passes it to |
| --- | --- |
| `/chain/<network>/indexer` | the indexer's GraphQL endpoint |
| `/chain/<network>/indexer/ws` | the indexer's WebSocket, which is how the wallet syncs |
| `/chain/<network>/node` | the node's RPC WebSocket, which is how transactions are submitted |

The server adds the project ID and forwards the request. In development that server is Vite ([`vite.config.ts`](vite.config.ts)), reading the IDs from `.env`. On the hosted site it is nginx ([`deploy/nginx.conf.template`](deploy/nginx.conf.template)), reading them from the environment.

The keys are hidden, not unusable: anyone can send requests through the site. The nginx configuration limits how fast one visitor can do that.

## Deploying

The hosted site is one small container: nginx serving the built page and forwarding chain requests. [`Dockerfile`](Dockerfile) builds it and [`fly.toml`](fly.toml) describes it for [Fly.io](https://fly.io).

```bash
fly apps create <your-app-name>          # and set the same name in fly.toml
fly secrets set BLOCKFROST_PREPROD_ID=... BLOCKFROST_PREVIEW_ID=... BLOCKFROST_MAINNET_ID=...
fly deploy --ha=false
```

Any host that runs a container works the same way: set the three environment variables and expose port 8080.

The site serves the circuit files the token contract needs. The one large file is `keys/mint.prover` (43 MB), the prover key for minting. Only that prover key is committed and served, because `mint` is the only contract circuit the page proves. `pnpm sizes` lists every circuit file.

## Project layout

| Path | What it is |
| --- | --- |
| `src/fanout.ts` | The payout: one transfer, many recipients. Start here. |
| `src/wallet/browser-wallet.ts` | The wallet's operations: register for DUST, pay, sign, submit. |
| `src/wallet/sdk-wallet.ts` | Building the wallet from a seed with the wallet SDK, and the settings that make it sync quickly. |
| `src/wallet/wallet-store.ts` | Where the seed and the sync state are kept in the browser. |
| `src/payout.ts` | Which line of a list was paid, which was not, and which can be sent again. |
| `src/PayoutPanel.tsx` | The payout screen. |
| `src/App.tsx` | The rest of the user interface, and the loop that pays a list. |
| `src/midnight/real-backend.ts` | Deploying and minting the token with Midnight.js. |
| `src/network.ts` | The three networks and where the page finds them. |
| `src/address.ts`, `src/amounts.ts` | Checking a shielded address; converting typed amounts. |
| `src/storage.ts` | What is kept in `localStorage`: your token and the progress of a payout. |
| `contract/` | The token contract, its witness, and the compiled output in `managed/`. |
| `sdk/` | One entry point for the wallet SDK, so the dev server bundles it once. |
| `scripts/check-recipients.mjs` | Checks from the chain which recipients were paid. |
| `scripts/copy-zk.mjs` | Copies the circuit files the site must serve into `public/`. |
| `deploy/`, `Dockerfile`, `fly.toml` | The hosted site. |

### Scripts

| Command | What it does |
| --- | --- |
| `pnpm dev` | Runs the app at http://localhost:3000. |
| `pnpm proof:up`, `pnpm proof:down` | Starts and stops the proof server ([`compose.yml`](compose.yml)). |
| `pnpm test` | Runs the tests. No wallet or network needed. |
| `pnpm typecheck` | Type-checks the project. |
| `pnpm build` | Builds the site into `dist/`. |
| `pnpm preview` | Serves `dist/` locally, with the same chain forwarding as `pnpm dev`. |
| `pnpm sizes` | Prints the size of every circuit file the site serves. |
| `pnpm compile` | Recompiles the contract. Needs the [Compact compiler](https://docs.midnight.network). |

### Tests

`pnpm test` covers what can be checked without a chain: address and amount parsing, cutting a list into transactions, the per-line payout record (what is safe to send again, what a reload does to it), and the compiled contract run in memory (the owner can mint, nobody else can, and the token type the app computes is the one the contract mints).

Nothing in the repository pretends to be a wallet or a chain. Sending a transaction is tested by sending one on a test network.

### The token contract

[`contract/FanoutToken.compact`](contract/FanoutToken.compact) is a thin wrapper around OpenZeppelin's [`ZOwnableNativeShieldedToken`](https://github.com/OpenZeppelin/compact-contracts) preset.

- **Only the owner mints and burns.** The owner is fixed at deploy as a commitment to `hash(owner's coin public key, secret nonce)`.
- **The secret nonce is the key to minting.** The app keeps it in the browser's `localStorage`. If you clear the site's data, nobody can mint that token again.
- **Every deployment is a new token.** The token type is derived from the contract address.

### Versions

Versions follow the pinned toolchain of the [official Midnight examples](https://github.com/midnightntwrk/midnight-examples).

| Component | Version |
| --- | --- |
| Wallet SDK | `@midnightntwrk/wallet-sdk` 2.0.1 |
| Ledger | `@midnightntwrk/ledger-v9` 1.0.2 |
| Midnight.js | 5.0.1 |
| Proof server | `midnightntwrk/proof-server` 9.0.2 |
| Compact compiler | 0.36.1 (language 0.28, runtime 0.21.0) |
| `@openzeppelin/compact-contracts` | 0.3.0 |

## Limits

- **A proof of concept.** The wallet's seed and the token's minting secret are stored unencrypted in the browser. A real custodian keeps them in a vault or an HSM.
- **Mainnet is offered, not proven.** Deploying, minting and paying out were run on Preprod. On Preview and Mainnet only syncing a new wallet was checked.
- **The hosted site needs the browser's permission to reach your proof server.** That was not confirmed in Chrome or Brave; running the app locally was.
- **One sending wallet, one transaction at a time.** Several sending wallets would pay in parallel; that was not tried.
- **64 recipients per transaction** is the largest size tried. By size about 190 would fit in a block.
- **Keep the tab open and in front during a payout.** Browsers slow background tabs down.
- **No burning or ownership transfer in the UI.** The contract supports both.

## License

[Apache-2.0](LICENSE). The contract file carries its own MIT header, as does the OpenZeppelin library it wraps. The Midnight name and logo belong to their owners.
