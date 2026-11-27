# Shielded fanout: notes for whoever works on this next

A proof of concept for Midnight: an in-page wallet (wallet SDK) mints a shielded token and pays many shielded wallets, 64 per transaction. README.md explains what it does and how to run it. This file is how to work on it.

## Run and check

```bash
pnpm install
cp .env.example .env    # fill in the Blockfrost project IDs
pnpm proof:up           # the proof server, in Docker
pnpm dev                # http://localhost:3000
```

Before you call a change done:

```bash
pnpm typecheck
pnpm test
pnpm build
```

CI runs the same three on every push.

## Rules

- **No mocks.** No pretend wallet, chain, indexer or proof server anywhere in the repository. Unit tests cover pure logic only. Anything that claims a transaction works was run on a test network, and the README says which.
- **No secrets in git.** Blockfrost project IDs live in `.env` locally and in the host's secrets when deployed. They are added to chain requests on the server side (`vite.config.ts`, `deploy/nginx.conf.template`) and must never reach the browser bundle: do not give them a `VITE_` name.
- **Recipients stay in memory.** Addresses and amounts are never stored or logged. What is stored about a payout is line numbers, hashes and times (`src/payout.ts`).
- **Never pay twice.** A transaction is built once. If it was built but the network has not reported it, its lines are held back from sending again until the network says what became of it. Keep `unpaidLines` in `src/payout.ts` the single place that decides what may be sent.
- **The contract is fixed.** Use `contract/FanoutToken.compact` as it is. The compiled output in `contract/managed/` is committed, so running the app needs no Compact compiler. `pnpm compile` regenerates it.
- **Public repository.** No private links, internal names or third parties' details in code, comments or commits.

## Things that cost time before

- **The wallet SDK is imported through `sdk/`**, a one-file workspace package. Importing its sub-paths directly makes the dev server bundle them separately, and the page then fails with an import cycle. After changing `sdk/`, delete `node_modules/.vite` and restart `pnpm dev`.
- **DUST sync.** `src/wallet/sdk-wallet.ts` hands the wallet each network's Ledger 9 starting point and uses the SDK's event-less sync at a low anonymity level. Without those a new wallet takes hours to sync or a minute to re-check its DUST. The comments there give the measurements.
- **Shielded sync.** The SDK finds a wallet's coins by trying its key on every shielded coin on the network, about 2 ms each in the browser: six minutes on Preprod. A newly created wallet skips that by starting from the indexer's collapsed coin tree (`src/wallet/tip-start.ts`). Only a wallet whose seed was generated in the page may do so; a restored wallet must read the history, or it would miss its coins.
- **Editing source reloads the open page.** A payout in progress is cut short by a reload. Do not edit while one is running. A hot update also keeps the running wallet object, so after changing `src/wallet/` reload the page fully.
- **The checker competes with the proof server.** `scripts/check-recipients.mjs` is processor-heavy. Run it between payouts, not during one.
- **Background tabs are slow.** Browsers throttle timers in tabs that are not in front, which makes a sync or a payout crawl.

## Where things are

`src/fanout.ts` is the payout. `src/wallet/` is the wallet. `src/payout.ts` is the record of what was paid. `src/App.tsx` holds the loop that pays a list (`payList`) and the page. The README has the full table.

## Style

Short files, comments that explain why, plain words on screen. The page follows midnight.network: near-black background, Outfit for text, DM Mono for labels, Midnight blue (#0000fe) for fills only.
