# Midnight Preprod · Shielded token fanout

Build a basic browser dApp in this repository. A user connects a Midnight Preprod wallet, deploys their own demo token, mints it into that wallet, and pays several shielded wallets in **one finalized payout transaction**. Give the demo its own name, contract and token type.

The repository is a public example. Its job is to let any developer clone it, run it and understand how a fanout payment is sent. Favor code that is short and easy to follow over features.

## Repository rules

- **Self-contained.** Everything the project needs is in this repository or installed by `pnpm install`. Refer to nothing else on the machine: no home-directory paths, no sibling folders, no services you did not start from here.
- **Public.** Commit no secrets, seeds, project IDs, private links or internal names. Secrets live in a gitignored `.env`, and a committed `.env.example` documents every variable.
- **Runs after a clone.** Commit the lockfile and the compiled contract output, so a developer needs no Compact compiler to run the demo. `pnpm compile` regenerates that output.
- **Publishing is the human’s call.** Commit locally as you go. Ask before you create the GitHub repository or push.

## Roles

- **Connected wallet.** Any browser wallet that implements DApp Connector API 4.x and registers under `window.midnight`. It deploys the token contract, owns it, mints, sends the payout and pays every fee in tDUST. Every approval happens in this wallet. There is no backend.
- **Recipients A and B.** Two seed-held wallets that a script in this repository creates, so another script can read their balances. They need no tNIGHT or tDUST to receive.
- **Human.** Approves every wallet prompt. You cannot drive a wallet extension, so test the UI against a mock `window.midnight` and hand the Preprod run to the human.

## What a developer needs

Write the README around this list, and keep it this short.

- Node 22 and pnpm.
- A connector-compatible wallet extension set to Preprod, holding tNIGHT from the [Preprod faucet](https://midnight-tmnight-preprod.nethermind.dev/) with tDUST generated from it.
- Only for the balance script: a Blockfrost Midnight Preprod project ID in `.env` as `BLOCKFROST_PROJECT_ID`. The browser needs none, because it takes its indexer and node endpoints from the wallet’s `getConfiguration()`.

No proof server is needed. The browser delegates proving to the connected wallet, and the scripts prove nothing.

## Developer experience

- **Quickstart.** Clone, `pnpm install`, `pnpm dev`, open the page, connect. Put these steps at the top of the README.
- **Mock mode.** `pnpm dev:mock` runs the same UI against the mock wallet, so a developer can click through the whole flow with no extension, no funds and no network.
- **One file for the payout.** Put the fanout in a small module with no UI imports, such as `src/fanout.ts`, and comment it for a first-time reader. It is the file people came for.
- **“How the fanout works.”** A README section that quotes that module and explains the transaction: the sender’s inputs, one output per recipient, the change output, who pays the fee, and what an observer of the chain can and cannot see.
- **Scripts.** `pnpm wallets:new` creates recipients A and B, writes their seeds to `.env` and prints their shielded addresses. `pnpm balances` syncs them and prints their demo token balances. `pnpm test` and `pnpm typecheck` run without a wallet or a network.
- **CI.** A GitHub Actions workflow runs install, typecheck and tests on every push.
- **License.** Apache-2.0, matching the official Midnight examples.

## User flow

1. **Connect.** List the wallets under `window.midnight` whose `apiVersion` is 4.x and call `connect('preprod')` on the chosen one. Show the wallet name, shielded address and network. Enable nothing else until `getConfiguration()` reports `preprod`. Show the tDUST balance from `getDustBalance()`. If it is zero, tell the user to generate tDUST from tNIGHT in their wallet.
2. **Deploy.** Once per wallet, deploy the demo token with `ownerId = _computeOwnerId(left(wallet coin public key), secretNonce)`. Persist the contract address, the secret nonce and the instance salt in the browser’s private state. Warn that clearing site data removes the ability to mint, because the contract has no owner recovery. Show the contract address and the token type from `tokenColor`.
3. **Mint.** Let the user enter an amount and mint to the wallet’s own shielded coin public key. Show the spendable balance once `getShieldedBalances()` reports the token.
4. **Distribute.** Start with two recipient rows and let the user add or remove rows. Validate each Preprod shielded address and each positive amount at the token’s precision. Show the total and the balance that will remain. Block submission when the total exceeds the spendable balance or tDUST is zero. The connector has no fee estimate, so do not display one. The wallet computes the fee.
5. **Send.** Make one `makeTransfer` call with one shielded output per recipient, then `submitTransaction`. The wallet selects inputs and returns change. The dApp never sees coins. Never fall back to several transactions. If the wallet cannot fit the list into one transaction, stop, and show the largest recipient count you have verified. Report `InsufficientFunds` and `Rejected` errors in plain words.
6. **Confirm.** Show each stage you can observe: waiting on the wallet while it builds and proves, submitted, finalized. Persist the payout transaction hash across refreshes and check its status at the indexer before offering a retry. Hold recipient addresses and amounts in memory only. Never send them to a server, log them or persist them.

## Preprod acceptance check

Deploy with 2 decimals. The amounts below are display units.

**You prepare:**

- UI tests that pass against the mock wallet.
- Wallets A and B from `pnpm wallets:new`, with their shielded addresses printed for the human.
- A clean-clone check: clone the repository into a temporary folder, follow the README quickstart exactly, and confirm that mock mode runs.

**The human runs:** connect, deploy, mint 100, then pay **17 to wallet A and 29 to wallet B** in one payout.

**Then verify:** `pnpm balances` shows 17 for A and 29 for B, and the sender’s wallet shows 54. A fresh deployment has a new token type, so all three start at zero. Record the single finalized payout hash in the README as a worked example. List the deploy and mint transactions separately. Do not report the check as passed until the human has run it on Preprod.

## Implementation references

Use only public sources, and link only public pages from committed files.

Base the demo token on OpenZeppelin’s `ZOwnableNativeShieldedToken` preset, in which only the owner mints and burns. Holders transfer coins through ZSwap directly, with no contract call. Write a thin wrapper contract that follows the example shipped in the package at `token/examples/ZOwnableNativeShieldedTokenExample.compact`. Pin `@openzeppelin/compact-contracts` to exactly `0.3.0`. A wrapper of this preset at that version compiles unchanged for Ledger 9 with Compact compiler 0.36.0, language 0.28, runtime 0.21.0 and ZKIR v3. npm’s `latest` is newer. [OpenZeppelin Compact contracts](https://github.com/OpenZeppelin/compact-contracts)

Take every other version from the root `toolchain.json` of the official examples: compiler, Midnight.js, wallet SDK, connector API and the `overrides` block. Read it and the lockfile before selecting dependencies. If its compiler pin differs from 0.36.0, use the pin and record the version you built with. The examples are an npm workspace, so restate their `overrides` under `pnpm.overrides`. [Official Midnight examples](https://github.com/midnightntwrk/midnight-examples)

- [Connector specification](https://github.com/midnightntwrk/midnight-dapp-connector-api/blob/main/SPECIFICATION.md). The authority for `connect`, `makeTransfer`, balances and error codes. Read it before any wallet vendor’s documentation.
- [Browser wallet](https://github.com/midnightntwrk/midnight-examples/tree/main/examples/leaderboard). The pattern to follow in the browser: indexer from the wallet’s `getConfiguration()`, proving delegated to the wallet, circuit keys served from the dApp’s own origin, compiled contract output committed.
- [Token transfers](https://github.com/midnightntwrk/midnight-examples/tree/main/examples/token-transfers). Shielded mint and send circuits.
- [Shielded minting and payouts](https://github.com/midnightntwrk/midnight-examples/tree/main/examples/shielded-chips). A shielded token minted and paid out to wallets, with notes on keeping coin nonces out of public state.

When the acceptance check has passed, replace this brief with the project’s run, test and convention notes, so later sessions are not told to build it again.
