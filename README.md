# Bitbank launchpad contracts

Open-source-ready V1 launchpad contracts for Bitbank on Robinhood Chain. **Development source; no Bitbank deployment is represented by this repository.**

Bitbank's proposed economics are a **1% V3 pool fee**, with **10% of collected LP fees for the protocol** and **90% for collaborators**. With that pool tier, the intended allocations correspond to **0.10% / 10bp** and **0.90% / 90bp** of fee-bearing trading volume. This is not a 0.10% total swap fee. LP ownership and any Uniswap pool protocol fee also affect actual realized revenue.

## Contracts

- `src/BitbankLaunchFactory.sol`: Pons V1 adaptation; ERC20 deployment, direct one-sided V3 pool liquidity, permanent position custody, optional creator initial buy from native value above `launchFee`. Restricts DEX configuration to the 1% fee tier / 200 tick spacing. Uses the caller's exact CREATE2 salt (scoped to the creator, since the creator is part of the init code). Caches the locker's immutable protocol recipient; the launch fee is paid straight to it. Launch records are packed into five storage slots and exposed through the Pons-shaped `getLaunchedToken`. Launch presets carry `sniperFeeBps`; a creator may opt out per launch with `TokenParams.sniperFeeDisabled`.
- `src/BitbankLauncherToken.sol`: Bitbank token (derived from the Pons V1 token, same read ABI for `logo`, `description`, `socials`, `getTokenInfo`, `deployer`, `pairToken`, `dexFactory`, `liquidityPool`, `launchBlock`). Metadata is stored as one ABI blob and decoded on read, which removes most constructor bytecode. The canonical pool is cached by the factory in the launch transaction. Launch block: only the creator's atomic initial buy can leave the pool (keyed on the immutable `deployer`, no mutable recipient slot). For `restrictionBlocks` after that, pool buys pay a sniper fee that decays linearly from `sniperFeeBps` to zero (`buyFeeBps()` view), then per-wallet and cumulative caps apply. Sells and wallet-to-wallet transfers are never taxed; after the window, `_update` is a single immutable comparison.
- `src/BitbankLaunchLocker.sol`: permanently holds launch position NFTs. One-time factory binding; immutable protocol recipient. Permissionless `collect` credits a cumulative 10/90 split, unaffected by fragmentation/rounding across collections. Permissionless `sync(token)` credits sniper fees (launch-token balance above what is already owed) through the same split. Fees are claimed by a pull mechanism to recorded payout recipients. There is no NFT withdrawal, liquidity decrease, upgrade, arbitrary call, or owner fee redirection.
- `src/BitbankFeeSplitter.sol`: immutable allocation across 1–20 distinct nonzero wallets, positive shares totaling 10,000. Anyone may trigger `release(asset,recipient)`; value always goes to the recorded recipient, not the caller. Cumulative accounting preserves proportional allocation across deposits. Floor-rounding dust can remain below one base unit per recipient until more fees arrive. Supports standard non-rebasing, non-fee-on-transfer ERC20 assets. It does not accept native ETH intentionally; V3 fees are ERC20, including WETH.
- `src/BitbankGasStation.sol`: relayer-submitted, user-signed (EIP-712) stablecoin-for-gas top-ups with optional ERC-2612 permit.
- `src/vendor/pons-v1`: unchanged original Pons V1 source, including its original factory and token for reference plus required math/interfaces. Do not deploy the original `PonsLaunchFactory` or `PonsLauncherToken` when the intended behavior is Bitbank's.
- `lib/openzeppelin-contracts`: original vendored dependencies from the inspected Pons source snapshot.

The protocol share is fixed in the locker. A launch's creator payout defaults to its creator or is set once by the factory during the atomic launch. For collaborator splits, deploy the splitter first and pass it as `TokenParams.feeWallet`. Social handles are not onchain authorities. They belong in application metadata; funds use explicit wallets. No social escrow, administrator reassignment, or handle ownership oracle is included.

## Validate

```sh
bun install --frozen-lockfile
bun run test
```

The Node suite compiles Solidity 0.8.30 via IR, optimizer 200 runs, Shanghai target; enforces the 24,576-byte EIP-170 limit; deploys contracts in a disposable Ganache EVM; and checks recipient validation, cumulative splitter releases, wrong callers, one-time factory binding, fixed fee tier, fragmented fee collection, destination-safe claims, and a full `launchToken` flow against a mock V3 stack (`test/Mocks.sol`): treasury launch fee, creator initial buy above the wallet cap, launch-block buy blocking, pool cache, packed record, sniper fee decay and `sync`, wallet/cumulative caps, creator opt-out, pre-created pool rejection, whitelist gating, and fee transfer failure. It prints gas for launches and buys. Generated ABI/bytecode files go into ignored `out/`.

Sizes (deployed bytes): factory 20,734 (embeds the token), token 5,909, locker 4,564, splitter 1,350.

Foundry compilation is configured separately:

```sh
forge build
```

The supplied Foundry profile uses Cancun. Compiler settings and source metadata affect runtime hashes; always pin hashes from the actual deployed runtime. The Bitbank Go app embeds splitter deployment bytecode generated by `bun run test` (Shanghai settings). Its `splitter_code_hash` must match that build when using the API's splitter deployment flow.

The mock suite is not an audit. Fork validation against the real Robinhood Chain Uniswap V3 deployment (factory, position manager, SwapRouter02, QuoterV2, WETH, USDG) runs in a ganache fork of mainnet:

```sh
bun run fork-test            # RPC_URL=... to use a private endpoint
```

It deploys the stack, launches a token with a creator initial buy, mines past the sniper window, buys with native ETH via `multicall(deadline,[exactInputSingle])`, rejects an expired deadline, sells via `multicall(deadline,[exactInputSingle -> router, unwrapWETH9 -> seller])` after one unlimited approval, collects and claims the 10/90 WETH and token fees, and performs USDG gas-station top-ups with a real `Global Dollar` v1 permit and with a plain allowance. Those are byte-for-byte the calldata shapes the Go app builds. It prints gas per step, the new pool's `feeProtocol`, the LP fee in basis points of ETH volume (expect 100) and the router/quoter runtime pins for the manifest. Solana/V2/V4 are not included.

## Deployment

`scripts/deploy.mjs` performs the whole sequence, including `BitbankGasStation` with USDG accepted, and writes `out/deployment-<chainId>.json` in the shape the Go app loads (`LAUNCHPAD_DEPLOYMENT_FILE`), including the `gas_station` block with the relayer address. It is a dry run unless `--broadcast` is passed, and it refuses to proceed if any pinned DEX address has no code on the target chain.

```sh
RPC_URL=... DEPLOYER_KEY=0x... RELAYER=0x... node scripts/deploy.mjs             # dry run
RPC_URL=... DEPLOYER_KEY=0x... RELAYER=0x... node scripts/deploy.mjs --broadcast
```

`RELAYER` is the address of the gas relayer hot key, which lives only on the operator machine (see `bitbankgo/maintenance.md`). `GAS_STATION=0` skips the station. On chain 4663 `WETH` and `USDG` default to the official addresses; the step-by-step launch checklist with the verified runtime hashes is `bitbankgo/finalsetup.md`.

The treasury (locker `protocolFeeRecipient`, receives the 10% share and launch fees) defaults to `ETH_ROBINHOOD_CHAIN_ADDRESS` from `../bitbankgo/.env`; override with `TREASURY`. On chain 4663 the Uniswap V3 factory, position manager, SwapRouter02 and QuoterV2 default to the addresses published by Uniswap for Robinhood Chain; verify them on the explorer before broadcasting and pass `WETH` explicitly. The Go app additionally refuses to sign when the locker's recipient differs from `ETH_ROBINHOOD_CHAIN_ADDRESS`.

Manual order: `BitbankLaunchLocker(owner, treasury)`; `BitbankLaunchFactory(owner, locker, launchFeeWei)`; `locker.bindFactory(factory)`; `factory.addDexConfig`; `factory.addLaunchConfig` (pair token, initial tick on the 200 spacing, wallet caps, `restrictionBlocks`, `sniperFeeBps`, router style, supply); `factory.setLaunchEnabled(true)` after real-chain checks. Deploy a `BitbankFeeSplitter` per community allocation and pass it as `feeWallet`.

Collect fees through `locker.collect(token)` (pool fees) and `locker.sync(token)` (sniper fees), then `locker.claim(asset, splitter)`, then `splitter.release(asset, recipient)`. The protocol recipient uses `locker.claim(asset, treasury)`.

Default preset in the deploy script: 1e9 supply, 2% wallet cap, 40 restriction blocks, 99% sniper fee at launch decaying to zero. On Robinhood Chain (Arbitrum Orbit) `block.number` inside the EVM is the Arbitrum One parent-chain block (~0.25s), not the L2 block the RPC reports, so 40 blocks is about ten seconds and `restrictionsEndBlock` is a parent-chain number; Pons has the same semantics.

## Provenance and licenses

Upstream: [ponsdotdev/ponsfamily](https://github.com/ponsdotdev/ponsfamily), commit `845bd546b37515621e47b08015ce4f9d374f6eca`. Original Pons authorship and SPDX notices are preserved. The new factory is a derived work with its changes called out separately. Original deployed Pons addresses in vendor comments refer only to Pons, never a Bitbank deployment.

New Bitbank files are MIT. The Pons V1 tick math retains **GPL-2.0-or-later**. Other vendored files retain their own licenses. See [LICENSES.md](LICENSES.md); do not describe the entire mixed-source distribution as uniformly MIT. The V2/V4 tree and its BUSL sources are not copied.

Intended repository: `bitbanknz/bitbankcontracts`.
