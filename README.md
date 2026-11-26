# Shielded fanout on Midnight Preprod

A small browser dApp that shows how to pay several shielded wallets in **one transaction** on [Midnight](https://midnight.network) Preprod. You connect a wallet, deploy and mint your own shielded token, then send it to as many recipients as you list. Either every recipient is paid or none is.

The payout itself is about fifteen lines, in [`src/fanout.ts`](src/fanout.ts). The rest of the project is what it takes to get a token to pay out with.

## Quickstart

```bash
git clone https://github.com/Jalal-1/shielded-fanout-example.git
cd shielded-fanout-example
pnpm install
pnpm dev
```

Open http://localhost:3000 and connect your wallet.

### Try it without a wallet

```bash
pnpm dev:mock
```

Mock mode runs the same UI against a pretend wallet and a pretend chain, both in memory. Nothing leaves the page. You can click through the whole flow with no extension, no funds and no network. Add `?unfunded` to the URL to see what a user with no tDUST sees.

## What you need

- Node 22 and pnpm.
- A Midnight wallet extension that supports DApp Connector API 4.x, set to **Preprod**.
- tNIGHT in that wallet from the [Preprod faucet](https://midnight-tmnight-preprod.nethermind.dev/), and tDUST generated from it in the wallet. Fees are paid in tDUST. The site does not fund wallets and cannot do this step for you.

You do not need a proof server, an API key or the Compact compiler. The wallet makes the proofs, the app uses the indexer your wallet is already configured with, and the compiled contract is committed.

## The flow

1. **Connect.** The app lists the wallets it finds under `window.midnight` and connects on Preprod.
2. **Fund.** It shows your tNIGHT and tDUST. Everything else stays disabled until you have tDUST.
3. **Deploy.** You deploy your own copy of the token contract. Your wallet owns it, so only you can mint.
4. **Mint.** You mint an amount to your own shielded address.
5. **Pay out.** You list recipients and amounts and send them all in one transaction.

## How the fanout works

A dApp never sees your coins. It tells the wallet what should happen, and the wallet works out how. For a fanout, that is one call with one output per recipient:

```ts
// src/fanout.ts
const { tx } = await wallet.makeTransfer(
  payments.map((payment) => ({
    kind: 'shielded' as const,
    type: tokenType,          // the token's 32-byte type, as hex
    value: payment.amount,    // in the token's smallest unit
    recipient: payment.recipient, // mn_shield-addr_preprod1...
  })),
);

await wallet.submitTransaction(tx);
```

`makeTransfer` and `submitTransaction` are part of the [DApp Connector API](https://github.com/midnightntwrk/midnight-dapp-connector-api/blob/main/SPECIFICATION.md), which every compatible wallet implements. Inside `makeTransfer` the wallet:

- **selects inputs:** which of your coins to spend,
- **creates the outputs:** one new coin per recipient,
- **returns the change:** one more coin back to you for whatever is left over,
- **pays the fee** in tDUST,
- **proves and signs** the transaction, after you approve it.

Because every output is in the same transaction, the payout is atomic. There is no state where the first recipient has been paid and the second has not.

Two things to know:

- **No contract is involved in the payout.** A shielded token on Midnight is a native coin. The contract is needed to mint it. Moving it is a plain wallet transfer.
- **A transaction has a size limit.** A long enough recipient list will not fit in one. The app does not split a payout across transactions. `LARGEST_VERIFIED_RECIPIENT_COUNT` in `src/fanout.ts` records the largest payout that has finalized on Preprod with this code.

### What the chain shows

Shielded transfers hide who paid whom and how much. Recipients' addresses and the amounts are not written on chain in the clear, and the app keeps them in memory only: it never stores, logs or sends them anywhere except to your wallet.

Some things are public:

- **That a transaction happened**, and roughly its shape, such as how many coins it created.
- **Minting.** A mint is a contract call. The contract keeps a public running total, so the amount you mint is visible.
- **Deploying.** The contract's address, and the name, symbol and decimals you chose.

## The token contract

[`contract/FanoutToken.compact`](contract/FanoutToken.compact) is a thin wrapper around OpenZeppelin's [`ZOwnableNativeShieldedToken`](https://github.com/OpenZeppelin/compact-contracts) preset. It re-exports every circuit of the preset and adds nothing.

- **Only the owner mints and burns.** The owner is fixed at deploy as a commitment to `hash(owner's coin public key, secret nonce)`.
- **The secret nonce is the key to minting.** This app keeps it in the browser's `localStorage`. If you clear the site's data, nobody can mint that token again. The contract has no recovery.
- **Every deployment is a new token.** The token type is derived from the contract address, so two users of this app never share a token.
- **This is a demo.** Do not use a token deployed from a web page's local storage for anything of value.

## Project layout

| Path | What it is |
| --- | --- |
| `src/fanout.ts` | The payout: one transfer, many recipients. Start here. |
| `src/wallet.ts` | Finding and connecting a wallet, balances, plain-language errors. |
| `src/midnight/real-backend.ts` | Deploying and minting on Preprod with Midnight.js. |
| `src/mock/mock-chain.ts` | The pretend wallet and chain behind `pnpm dev:mock` and the tests. |
| `src/App.tsx` | The user interface. |
| `src/address.ts`, `src/amounts.ts` | Checking a shielded address; converting typed amounts. |
| `src/storage.ts` | What is kept in `localStorage`: your token and the last payout hash. |
| `contract/` | The token contract, its witness, and the compiled output in `managed/`. |
| `scripts/copy-zk.mjs` | Copies the circuit files the site must serve into `public/`. |

## Scripts

| Command | What it does |
| --- | --- |
| `pnpm dev` | Runs the app against a real wallet on Preprod. |
| `pnpm dev:mock` | Runs the app against the in-memory mock. |
| `pnpm test` | Runs the tests. No wallet or network needed. |
| `pnpm typecheck` | Type-checks the project. |
| `pnpm build` | Builds the static site into `dist/`. |
| `pnpm preview` | Serves `dist/` locally. |
| `pnpm sizes` | Prints the size of every circuit file the site serves. |
| `pnpm compile` | Recompiles the contract. Needs the [Compact compiler](https://docs.midnight.network). |

## Tests

`pnpm test` covers:

- the payout module, against a fake wallet,
- the whole UI flow against the mock wallet: mint 100, pay 17 and 29 in one transaction, end with 54,
- the compiled contract, run in memory: the owner can mint, nobody else can, and the token type the app computes is the one the contract mints,
- the real Midnight.js deploy path, up to the moment the transaction is handed to the wallet.

## Versions

Versions follow the pinned toolchain of the [official Midnight examples](https://github.com/midnightntwrk/midnight-examples) (`toolchain.json`).

| Component | Version |
| --- | --- |
| Compact compiler | 0.36.1 (language 0.28, runtime 0.21.0) |
| `@openzeppelin/compact-contracts` | 0.3.0 |
| Midnight.js | 5.0.1 |
| DApp Connector API | 4.0.1 |
| Ledger | `@midnightntwrk/ledger-v9` 1.0.2 |

## Deploying

The app is a static site with no server code and no secrets.

```bash
pnpm build
```

Upload the `dist/` folder to any static host that serves over HTTPS. Asset paths are relative, so it works at a domain root or under a sub-path.

The site serves the circuit files below from its own origin. The wallet needs them to prove a mint, and a deploy carries every verifier key.

| File | Size |
| --- | ---: |
| `keys/mint.prover` | 43.0 MB |
| `keys/*.verifier` (10 files) | 17 KB |
| `zkir/*.bzkir` (10 files) | 13 KB |
| `compiler/*.json` (2 files) | 17 KB |
| **Circuit files** | **43.1 MB** |
| WebAssembly and JavaScript | 26 MB |
| **`dist/` in total** | **69 MB** |

`keys/mint.prover` is the one large file. Check your host's per-file size limit before you choose it: some static hosts cap a single file at 25 MB.

Only the prover key for `mint` is committed and served, because `mint` is the only circuit the UI proves. Compiling produces a prover key for every circuit (184 MB in all, with `burn.prover` at 86 MB). To serve another circuit, add it to `PROVED` in `scripts/copy-zk.mjs`.

## Status

Checked so far, without a real wallet:

- All tests pass, and the production build runs from `pnpm preview`.
- Mock mode works end to end in a browser.
- The real deploy path runs in a browser up to the wallet: the contract's constructor runs, the verifier keys load, and a deploy transaction is handed to the wallet.

Not yet checked on Preprod with a real wallet:

- deploying, minting and paying out through a wallet extension,
- that the wallet shows the minted token and accepts a multi-recipient `makeTransfer`,
- how many recipients fit in one transaction.

**Worked example on Preprod:** not recorded yet. When a payout has finalized, its transaction hash goes here.

## Known limits

- **Keep the tab open while a deploy finalizes.** If the page closes mid-deploy, the app cannot learn the new contract's address.
- **One browser, one owner.** The minting secret lives in this browser. There is no export or import.
- **No burning or ownership transfer in the UI.** The contract supports both. The app does not expose them.

## License

[Apache-2.0](LICENSE). The contract file carries its own MIT header, as does the OpenZeppelin library it wraps.
