#!/usr/bin/env bash
# Broadcast the Bitbank contracts to Robinhood Chain mainnet. Reads the deployer key from .deployerkey
# (mode 600, gitignored) so it is never pasted anywhere. Dry run: scripts/broadcast-4663.sh --dry
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f .deployerkey ] || { echo "missing .deployerkey" >&2; exit 1; }
DEPLOYER_KEY=$(tr -d '[:space:]' < .deployerkey)
[[ "$DEPLOYER_KEY" =~ ^0x[0-9a-fA-F]{64}$ ]] || { echo ".deployerkey must be 0x + 64 hex" >&2; exit 1; }
EXPECTED_DEPLOYER=0x09036eC6a7d5B2740e48276A93fd2076082dA9c0
ACTUAL=$(DEPLOYER_KEY="$DEPLOYER_KEY" node -e 'import("ethers").then(({Wallet})=>console.log(new Wallet(process.env.DEPLOYER_KEY).address))')
[ "${ACTUAL,,}" = "${EXPECTED_DEPLOYER,,}" ] || { echo "key in .deployerkey derives to $ACTUAL, expected $EXPECTED_DEPLOYER" >&2; exit 1; }
echo "deployer $ACTUAL"
export DEPLOYER_KEY RPC_URL=https://rpc.mainnet.chain.robinhood.com RELAYER=0xa71E8E2ae86e7845a605398654c26F521b2068D2 LAUNCH_FEE_WEI=0 LAUNCH_ENABLED=0
mkdir -p out
if [ "${1:-}" = "--dry" ]; then node scripts/deploy.mjs; else node scripts/deploy.mjs --broadcast 2>&1 | tee out/deploy-4663.log; fi
