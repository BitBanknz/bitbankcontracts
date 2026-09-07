// Deploys locker -> factory -> bind -> dex config -> launch preset -> gas station and writes a Go manifest.
// Dry run by default; pass --broadcast to send. Env: RPC_URL, DEPLOYER_KEY, WETH, optional OWNER,
// TREASURY (default: ETH_ROBINHOOD_CHAIN_ADDRESS from ../bitbankgo/.env), LAUNCH_FEE_WEI, V3_FACTORY,
// V3_POSITION_MANAGER, V3_ROUTER, V3_ROUTER_DEADLINE (1 for classic SwapRouter), V3_QUOTER, INITIAL_TICK,
// SUPPLY, MAX_WALLET_BPS, RESTRICTION_BLOCKS, SNIPER_FEE_BPS, LAUNCH_ENABLED.
// Gas station: RELAYER (address of the cmd/gasbot hot key; required unless GAS_STATION=0), USDG (default on
// 4663), GAS_MAX_ETH_WEI (per top-up cap, default 0.05 ETH), GAS_MARKUP_BPS (default 300), GAS_POOL_FEE (500).
import fs from 'node:fs';
import { JsonRpcProvider, Wallet, ContractFactory, Contract, keccak256, parseEther } from 'ethers';
import { compile, writeArtifacts } from './compile.mjs';

// Robinhood Chain mainnet: Uniswap-published V3 addresses plus the official WETH and Paxos USDG (permit: "Global Dollar" v1).
const ROBINHOOD_MAINNET = { chainId: 4663, factory: '0x1f7d7550b1b028f7571e69a784071f0205fd2efa', positionManager: '0x73991a25c818bf1f1128deaab1492d45638de0d3', router: '0xcaf681a66d020601342297493863e78c959e5cb2', routerDeadline: false, quoter: '0x33e885ed0ec9bf04ecfb19341582aadcb4c8a9e7', weth: '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73', usdg: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168' };
const env = (k, d) => process.env[k] ?? d;
function treasuryFromGoEnv() {
  for (const p of ['../bitbankgo/.env', '../../bitbankgo/.env']) {
    if (!fs.existsSync(p)) continue;
    const m = fs.readFileSync(p, 'utf8').match(/^ETH_ROBINHOOD_CHAIN_ADDRESS=(0x[0-9a-fA-F]{40})/m);
    if (m) return m[1];
  }
  return undefined;
}
const broadcast = process.argv.includes('--broadcast');
const provider = new JsonRpcProvider(env('RPC_URL', 'https://rpc.testnet.chain.robinhood.com'));
const chainId = Number((await provider.getNetwork()).chainId);
const defaults = chainId === ROBINHOOD_MAINNET.chainId ? ROBINHOOD_MAINNET : {};
const cfg = {
  treasury: env('TREASURY', treasuryFromGoEnv()), weth: env('WETH', defaults.weth), launchFee: BigInt(env('LAUNCH_FEE_WEI', '0')),
  gasStation: env('GAS_STATION', '1') === '1', relayer: env('RELAYER'), usdg: env('USDG', defaults.usdg), gasMaxEth: BigInt(env('GAS_MAX_ETH_WEI', parseEther('0.05').toString())), gasMarkupBps: Number(env('GAS_MARKUP_BPS', '300')), gasPoolFee: Number(env('GAS_POOL_FEE', '500')),
  factory: env('V3_FACTORY', defaults.factory), positionManager: env('V3_POSITION_MANAGER', defaults.positionManager),
  router: env('V3_ROUTER', defaults.router), routerDeadline: env('V3_ROUTER_DEADLINE', defaults.routerDeadline ? '1' : '0') === '1',
  quoter: env('V3_QUOTER', defaults.quoter), initialTick: Number(env('INITIAL_TICK', '-207400')), supply: parseEther(env('SUPPLY', '1000000000')),
  maxWalletBps: Number(env('MAX_WALLET_BPS', '200')), restrictionBlocks: Number(env('RESTRICTION_BLOCKS', '40')), sniperFeeBps: Number(env('SNIPER_FEE_BPS', '9900')),
  launchEnabled: env('LAUNCH_ENABLED', '0') === '1',
};
for (const k of ['treasury', 'weth', 'factory', 'positionManager', 'router', 'quoter', ...(cfg.gasStation ? ['relayer', 'usdg'] : [])]) if (!/^0x[0-9a-fA-F]{40}$/.test(cfg[k] ?? '')) throw new Error(`missing ${k}`);
const maxTxBps = Math.min(10000, Math.floor(cfg.maxWalletBps * 110 / 100));
const launchConfig = [cfg.weth, cfg.initialTick, cfg.maxWalletBps, maxTxBps, cfg.restrictionBlocks, cfg.sniperFeeBps, true, cfg.routerDeadline, cfg.supply];
console.log(JSON.stringify({ chainId, ...cfg, supply: cfg.supply.toString(), launchFee: cfg.launchFee.toString(), gasMaxEth: cfg.gasMaxEth.toString(), maxTxBps, broadcast }, null, 1));

const { find } = compile();
writeArtifacts(find);
for (const [name, addr] of [['factory', cfg.factory], ['positionManager', cfg.positionManager], ['router', cfg.router], ['quoter', cfg.quoter], ['weth', cfg.weth], ...(cfg.gasStation ? [['usdg', cfg.usdg]] : [])]) {
  if ((await provider.getCode(addr)) === '0x') throw new Error(`${name} ${addr} has no code on chain ${chainId}`);
}
if (!broadcast) { console.log('dry run complete; rerun with --broadcast'); process.exit(0); }

const wallet = new Wallet(env('DEPLOYER_KEY'), provider);
const owner = env('OWNER', wallet.address);
const deploy = async (name, args) => { const c = find(name); const contract = await new ContractFactory(c.abi, c.evm.bytecode.object, wallet).deploy(...args); await contract.waitForDeployment(); console.log(`${name} ${contract.target}`); return contract; };
const send = async p => (await p).wait();
const locker = await deploy('BitbankLaunchLocker', [owner, cfg.treasury]);
const factory = await deploy('BitbankLaunchFactory', [owner, locker.target, cfg.launchFee]);
if (owner.toLowerCase() !== wallet.address.toLowerCase()) console.log('owner differs from deployer: bindFactory/addDexConfig/addLaunchConfig must be sent by the owner');
else {
  await send(locker.bindFactory(factory.target));
  await send(factory.addDexConfig([cfg.factory, cfg.positionManager, cfg.router, 10000, 200, true]));
  await send(factory.addLaunchConfig(launchConfig));
  if (cfg.launchEnabled) await send(factory.setLaunchEnabled(true));
}
let station;
if (cfg.gasStation) {
  station = await deploy('BitbankGasStation', [owner, cfg.relayer, cfg.gasMaxEth]);
  if (owner.toLowerCase() === wallet.address.toLowerCase()) await send(station.setAcceptedToken(cfg.usdg, true));
  else console.log('owner differs from deployer: station.setAcceptedToken(USDG,true) must be sent by the owner');
}
const pin = async addr => ({ address: addr, code_hash: keccak256(await provider.getCode(addr)) });
const manifest = {
  chain_id: chainId, rpc_url: env('RPC_URL'), factory: await pin(factory.target), locker: await pin(locker.target), router: await pin(cfg.router), quoter: await pin(cfg.quoter),
  weth: cfg.weth, splitter_code_hash: keccak256('0x' + find('BitbankFeeSplitter').evm.deployedBytecode.object), launch_config_id: 0, dex_id: 0,
  ...(station ? { gas_station: { contract: await pin(station.target), relayer: cfg.relayer, markup_bps: cfg.gasMarkupBps, max_eth_wei: cfg.gasMaxEth.toString(), tokens: [{ symbol: 'USDG', address: cfg.usdg, decimals: 6, pool_fee: cfg.gasPoolFee, permit: true, permit_name: 'Global Dollar', permit_version: '1' }] } } : {}),
};
fs.writeFileSync(`out/deployment-${chainId}.json`, JSON.stringify(manifest, null, 2) + '\n');
console.log(`wrote out/deployment-${chainId}.json; verify protocolFeeRecipient == ${cfg.treasury}:`, await new Contract(locker.target, find('BitbankLaunchLocker').abi, provider).protocolFeeRecipient());
