# Midnight Preprod · Shielded token fanout

Build a basic browser dApp in this repository. A user connects a Midnight Preprod wallet, deploys and mints their own shielded ZSwap token, and pays several shielded wallets in **one finalized payout transaction**. Give the demo its own name and token metadata.

The repository is a public example, and the site will be hosted. Its job is to let any developer clone it, run it and understand how a fanout payment is sent. Favor code that is short and easy to follow over features.

## Repository rules

- **Self-contained.** Everything the project needs is in this repository or installed by `pnpm install`. Refer to nothing else on the machine: no home-directory paths, no sibling folders, no services you did not start from here.
- **Public.** Commit no secrets, seeds, private links or internal names. The app needs no secrets. If you add a variable, document it in a committed `.env.example`.
- **Runs after a clone.** Commit the lockfile and the compiled contract output, so a developer needs no Compact compiler to run the demo. `pnpm compile` regenerates that output.
- **Publishing is the human’s call.** Commit locally as you go. Ask before you push, and before you deploy the site anywhere.

## Roles

- **Connected wallet.** Any browser wallet that implements DApp Connector API 4.x and registers under `window.midnight`. It deploys the token contract, owns it, mints, sends the payout and pays every fee in tDUST. Every approval happens in this wallet. There is no backend.
- **Recipients.** Whatever Preprod shielded addresses the user enters. They need no tNIGHT or tDUST to receive. The project creates no wallets and holds no seeds.
- **Human.** Approves every wallet prompt. You cannot drive a wallet extension, so test the UI against a mock `window.midnight` and hand the Preprod run to the human.

## Funding is the user’s job

The site never funds a wallet, never registers DUST and never asks for a seed. Each user brings their own:

1. tNIGHT from the [Preprod faucet](https://midnight-tmnight-preprod.nethermind.dev/).
2. tDUST, which they generate from that tNIGHT in their own wallet.

When either is missing, say so and show these two steps with the faucet link. Read tNIGHT from `getUnshieldedBalances()` and tDUST from `getDustBalance()`, and let the user re-check without reloading. Keep deploy, mint and send disabled until tDUST is above zero.

## What a developer needs

Write the README around this list, and keep it this short.

- Node 22 and pnpm.
- A connector-compatible wallet extension set to Preprod, funded as described above.

No proof server and no API key are needed. The browser delegates proving to the connected wallet and takes its indexer and node endpoints from the wallet’s `getConfiguration()`.

## Developer experience

- **Quickstart.** Clone, `pnpm install`, `pnpm dev`, open the page, connect. Put these steps at the top of the README.
- **Mock mode.** `pnpm dev:mock` runs the same UI against the mock wallet, so a developer can click through the whole flow with no extension, no funds and no network.
- **One file for the payout.** Put the fanout in a small module with no UI imports, such as `src/fanout.ts`, and comment it for a first-time reader. It is the file people came for.
- **“How the fanout works.”** A README section that quotes that module and explains the transaction: the sender’s inputs, one output per recipient, the change output, who pays the fee, and what an observer of the chain can and cannot see.
- **Scripts.** `pnpm test` and `pnpm typecheck` run without a wallet or a network.
- **CI.** A GitHub Actions workflow runs install, typecheck, tests and the production build on every push.
- **License.** Apache-2.0 for the project, matching the official Midnight examples. The contract file keeps its own MIT header.

## User flow

1. **Connect.** List the wallets under `window.midnight` whose `apiVersion` is 4.x and call `connect('preprod')` on the chosen one. Show the wallet name, shielded address and network. Enable nothing else until `getConfiguration()` reports `preprod`. Show the tNIGHT and tDUST balances, with the funding steps when either is zero.
2. **Deploy.** Once per wallet, deploy the token with `ownerId = _computeOwnerId(left(wallet coin public key), secretNonce)`. Persist the contract address, the secret nonce and the instance salt in the browser’s private state. Warn that clearing site data removes the ability to mint, because the contract has no owner recovery. Show the contract address and the token type from `tokenColor`.
3. **Mint.** Let the user enter an amount and mint to the wallet’s own shielded coin public key. Show the spendable balance once `getShieldedBalances()` reports the token.
4. **Distribute.** Start with two recipient rows and let the user add or remove rows. Validate each Preprod shielded address and each positive amount at the token’s precision. Show the total and the balance that will remain. Block submission when the total exceeds the spendable balance or tDUST is zero. The connector has no fee estimate, so do not display one. The wallet computes the fee.
5. **Send.** Make one `makeTransfer` call with one shielded output per recipient, then `submitTransaction`. The wallet selects inputs and returns change. The dApp never sees coins. Never fall back to several transactions. If the wallet cannot fit the list into one transaction, stop, and show the largest recipient count you have verified. Report `InsufficientFunds` and `Rejected` errors in plain words.
6. **Confirm.** Show each stage you can observe: waiting on the wallet while it builds and proves, submitted, finalized. Persist the payout transaction hash across refreshes and check its status at the indexer before offering a retry. Hold recipient addresses and amounts in memory only. Never send them to a server, log them or persist them.

## Token contract

The contract is already in the repository at `contract/FanoutToken.compact`. Use it exactly as it is. Do not add, remove or change circuits, ledger fields or the constructor.

- It is a thin wrapper around OpenZeppelin’s `ZOwnableNativeShieldedToken` preset that re-exports every circuit and ledger field. Only the owner mints and burns. Holders transfer coins through ZSwap directly, with no contract call, which is why the payout is a wallet transfer.
- The name, symbol and decimals are constructor arguments, so the demo’s identity is set at deploy.
- Its two import paths expect `node_modules` beside the file. Make them resolve without editing anything else. A `contract` workspace package that depends on the library is the simplest way.
- Pin `@openzeppelin/compact-contracts` to exactly `0.3.0`. The file compiles unchanged for Ledger 9 with Compact compiler 0.36.0, language 0.28, runtime 0.21.0 and ZKIR v3, and produces 10 circuits. npm’s `latest` is newer.
- The UI uses the constructor, `mint`, `tokenColor` and the metadata circuits. It does not need to expose burning or ownership transfer.

## Hosting

The site will be hosted publicly after the acceptance check. Build for that from the start.

- **Static only.** `pnpm build` produces a folder that any static host can serve over HTTPS. No server code, no build-time secrets, no analytics.
- **Host-agnostic.** Use relative asset paths and no hard-coded origin, so the same build works on a preview URL, a custom domain or `pnpm preview`.
- **Circuit keys on the same origin.** Proving loads prover keys, verifier keys and ZKIR from the site itself. Record each file’s size in the README. Hosts and GitHub cap file sizes, so if any file is over 50 MB, stop and ask. Deploy needs every verifier key, but proving needs keys only for the circuits the UI calls.
- **Preprod only.** Refuse any other network.
- **One user, one token.** Each visitor deploys their own contract and keeps its secrets in their own browser. The site shares no state between users.

Do not choose a host or deploy. Leave a short “Deploying” README section that covers the build command, the output folder and the size table.

## Preprod acceptance check

Deploy with 2 decimals. The amounts below are display units.

**You prepare:**

- UI tests that pass against the mock wallet.
- A clean-clone check: clone the repository into a temporary folder, follow the README quickstart exactly, and confirm that mock mode runs.
- A production build that runs from `pnpm preview`.

**The human runs**, with a wallet they funded themselves: connect, deploy, mint 100, then pay **17 to one wallet and 29 to another** in one payout. The recipients are any two shielded addresses the human can open.

**Then verify:** the recipient wallets show 17 and 29, the sender shows 54, and the indexer reports the payout as finalized. A fresh deployment has a new token type, so all three start at zero. Record the single finalized payout hash in the README as a worked example. List the deploy and mint transactions separately. Do not report the check as passed until the human has run it on Preprod.

## Implementation references

Use only public sources, and link only public pages from committed files.

Take every version other than the contract library from the root `toolchain.json` of the official examples: compiler, Midnight.js, wallet SDK, connector API and the `overrides` block. Read it and the lockfile before selecting dependencies. If its compiler pin differs from 0.36.0, use the pin and record the version you built with. The examples are an npm workspace, so restate their `overrides` under `pnpm.overrides`. [Official Midnight examples](https://github.com/midnightntwrk/midnight-examples)

- [Connector specification](https://github.com/midnightntwrk/midnight-dapp-connector-api/blob/main/SPECIFICATION.md). The authority for `connect`, `makeTransfer`, balances and error codes. Read it before any wallet vendor’s documentation.
- [OpenZeppelin Compact contracts](https://github.com/OpenZeppelin/compact-contracts). The preset the token wraps.
- [Browser wallet](https://github.com/midnightntwrk/midnight-examples/tree/main/examples/leaderboard). The pattern to follow in the browser: indexer from the wallet’s `getConfiguration()`, proving delegated to the wallet, circuit keys served from the dApp’s own origin, compiled contract output committed, static hosting with no server code.
- [Token transfers](https://github.com/midnightntwrk/midnight-examples/tree/main/examples/token-transfers). Shielded mint and send circuits.
- [Shielded minting and payouts](https://github.com/midnightntwrk/midnight-examples/tree/main/examples/shielded-chips). A shielded token minted and paid out to wallets, with notes on keeping coin nonces out of public state.

When the acceptance check has passed, replace this brief with the project’s run, test and convention notes, so later sessions are not told to build it again.
