// Fork validation against real Robinhood Chain Uniswap V3 infrastructure (ganache fork of mainnet).
// Deploys locker/factory/gas station, launches a token, then exercises exactly the calldata the Go app
// builds: native-ETH buy via SwapRouter02 multicall(deadline,[exactInputSingle]), sell via
// multicall(deadline,[exactInputSingle -> router, unwrapWETH9 -> seller]), expiry, locker collect/claim,
// and a USDG permit gas-station top-up. RPC_URL overrides the public endpoint.
import assert from 'node:assert/strict';
import ganache from 'ganache';
import { BrowserProvider, Contract, ContractFactory, Wallet, ZeroAddress, MaxUint256, parseEther, parseUnits, formatEther, formatUnits, randomBytes, hexlify, Signature, keccak256 } from 'ethers';
import { compile } from './compile.mjs';

const M = { factory: '0x1f7d7550b1b028f7571e69a784071f0205fd2efa', positionManager: '0x73991a25c818bf1f1128deaab1492d45638de0d3', router: '0xcaf681a66d020601342297493863e78c959e5cb2', quoter: '0x33e885ed0ec9bf04ecfb19341582aadcb4c8a9e7', weth: '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73', usdg: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168' };
const ADDRESS_THIS = '0x0000000000000000000000000000000000000002';
const t0 = Date.now(); const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);
const { find } = compile();
const engine = ganache.provider({ logging: { quiet: true }, chain: { hardfork: 'shanghai' }, fork: { url: process.env.RPC_URL || 'https://rpc.mainnet.chain.robinhood.com' }, wallet: { totalAccounts: 6, defaultBalance: 1000 }, miner: { blockGasLimit: 60_000_000 } });
const provider = new BrowserProvider(engine, undefined, { cacheTimeout: -1 }); provider.pollingInterval = 10;
const chainId = Number((await provider.getNetwork()).chainId);
const signers = await Promise.all([0, 1, 2, 3, 4, 5].map(i => provider.getSigner(i)));
const addresses = await Promise.all(signers.map(s => s.getAddress()));
const [owner, creator, buyer, relayer, treasury, funder] = signers;
const deploy = async (name, args, signer = owner) => { const c = find(name); const k = await new ContractFactory(c.abi, c.evm.bytecode.object, signer).deploy(...args); await k.waitForDeployment(); return k; };
const tx = async p => (await p).wait();
const rejects = async p => assert.rejects(async () => { const r = await p; if (r?.wait) await r.wait(); });
const mine = async n => { for (let i = 0; i < n; i++) await engine.request({ method: 'evm_mine', params: [] }); };
const gas = {};
log('forked chain', chainId, 'block', await provider.getBlockNumber());

const erc20 = ['function balanceOf(address) view returns (uint256)', 'function approve(address,uint256) returns (bool)', 'function allowance(address,address) view returns (uint256)', 'function transfer(address,uint256) returns (bool)', 'function nonces(address) view returns (uint256)', 'function decimals() view returns (uint8)'];
const routerAbi = ['function multicall(uint256 deadline, bytes[] data) payable returns (bytes[])', 'function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)) payable returns (uint256)', 'function unwrapWETH9(uint256 amountMinimum, address recipient) payable'];
const router = new Contract(M.router, routerAbi, provider);
const quoter = new Contract(M.quoter, ['function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96)) returns (uint256 amountOut,uint160,uint32,uint256)'], provider);
const v3 = new Contract(M.factory, ['function getPool(address,address,uint24) view returns (address)'], provider);
const weth = new Contract(M.weth, erc20, provider);
const quote = async (tokenIn, tokenOut, amountIn) => (await quoter.quoteExactInputSingle.staticCall({ tokenIn, tokenOut, amountIn, fee: 10000, sqrtPriceLimitX96: 0 })).amountOut;
const swapCall = (tokenIn, tokenOut, recipient, amountIn, minOut) => router.interface.encodeFunctionData('exactInputSingle', [{ tokenIn, tokenOut, fee: 10000, recipient, amountIn, amountOutMinimum: minOut, sqrtPriceLimitX96: 0 }]);
const deadline = async (delta = 60) => BigInt((await provider.getBlock('latest')).timestamp + delta);

// 1. Deploy the Bitbank stack against the real DEX.
const launchFee = parseEther('0.001');
const locker = await deploy('BitbankLaunchLocker', [addresses[0], addresses[4]]);
const factory = await deploy('BitbankLaunchFactory', [addresses[0], locker.target, launchFee]);
await tx(locker.bindFactory(factory.target));
await tx(factory.addDexConfig([M.factory, M.positionManager, M.router, 10000, 200, true]));
const supply = parseEther('1000000000');
await tx(factory.addLaunchConfig([M.weth, -207400, 200, 220, 40, 9900, true, false, supply]));
await tx(factory.setLaunchEnabled(true));
log('deployed locker', locker.target, 'factory', factory.target);

// 2. Launch with a creator initial buy through the real SwapRouter02.
const params = ['Fork Test', 'FORK', 'ipfs://logo', 'fork validation', ['', '', '', 'https://bitbank.nz', ''], ZeroAddress, false];
const salt = hexlify(randomBytes(32));
const predicted = await factory.predictTokenAddress(params, 0, 0, salt, addresses[1]);
const treasuryBefore = await provider.getBalance(addresses[4]);
let r = await tx(factory.connect(creator).launchToken(params, 0, 0, salt, { value: launchFee + parseEther('0.1') }));
gas.launchWithInitialBuy = r.gasUsed; const launchBlock = BigInt(r.blockNumber);
assert.equal((await provider.getBalance(addresses[4])) - treasuryBefore, launchFee);
const token = new Contract(predicted, [...find('BitbankLauncherToken').abi], provider);
const pool = await v3.getPool(predicted, M.weth, 10000);
assert.notEqual(pool, ZeroAddress); assert.equal(await token.pool(), pool);
const record = await factory.getLaunchedToken(predicted); assert.equal(record.exists, true); assert.equal(record.initialBuyAmount, parseEther('0.1'));
const pm = new Contract(M.positionManager, ['function ownerOf(uint256) view returns (address)'], provider);
assert.equal(await pm.ownerOf(record.positionId), locker.target);
const creatorTokens = await token.balanceOf(addresses[1]); assert.ok(creatorTokens > 0n);
const poolC = new Contract(pool, ['function slot0() view returns (uint160,int24,uint16,uint16,uint16,uint8,bool)', 'function liquidity() view returns (uint128)'], provider);
const slot0 = await poolC.slot0();
log('launched', predicted, 'pool', pool, 'creator got', formatEther(creatorTokens), 'FORK for 0.1 ETH; pool feeProtocol', slot0[5], 'gas', gas.launchWithInitialBuy.toString());

// 3. Sniper window: a stranger's buy in the launch block is blocked; after it a fee applies; then caps only.
await rejects(router.connect(buyer).multicall(await deadline(), [swapCall(M.weth, predicted, addresses[2], parseEther('0.01'), 0)], { value: parseEther('0.01') }).then(t => t.wait()).catch(e => { if (BigInt(r.blockNumber) !== launchBlock) throw new Error('not launch block'); throw e; }));
await mine(40);
assert.equal(await token.buyFeeBps(), 0n);

// 4. Buy exactly like the Go adapter: native ETH, multicall(deadline, [exactInputSingle]).
const buyIn = parseEther('0.05'); const buyOut = await quote(M.weth, predicted, buyIn); const buyMin = buyOut * 99n / 100n;
const ethBefore = await provider.getBalance(addresses[2]);
r = await tx(router.connect(buyer).multicall(await deadline(), [swapCall(M.weth, predicted, addresses[2], buyIn, buyMin)], { value: buyIn }));
gas.buy = r.gasUsed;
const got = await token.balanceOf(addresses[2]);
assert.ok(got >= buyMin, 'buy below minimum'); assert.equal(await weth.balanceOf(addresses[2]), 0n, 'leftover WETH');
assert.equal(ethBefore - (await provider.getBalance(addresses[2])), buyIn + r.gasUsed * r.gasPrice);
log('buy', formatEther(buyIn), 'ETH ->', formatEther(got), 'FORK (quoted', formatEther(buyOut) + ') gas', gas.buy.toString());

// 5. Expired quote is rejected onchain by the router deadline.
await rejects(router.connect(buyer).multicall(await deadline(-1), [swapCall(M.weth, predicted, addresses[2], buyIn, 0)], { value: buyIn }));

// 6. Sell exactly like the Go adapter: one unlimited approval, then multicall([swap -> router, unwrapWETH9 -> seller]).
const sellIn = got / 2n; const sellOut = await quote(predicted, M.weth, sellIn); const sellMin = sellOut * 99n / 100n;
r = await tx(token.connect(buyer).approve(M.router, MaxUint256)); gas.approve = r.gasUsed;
const beforeSell = await provider.getBalance(addresses[2]);
r = await tx(router.connect(buyer).multicall(await deadline(), [swapCall(predicted, M.weth, ADDRESS_THIS, sellIn, sellMin), router.interface.encodeFunctionData('unwrapWETH9', [sellMin, addresses[2]])]));
gas.sell = r.gasUsed;
const received = (await provider.getBalance(addresses[2])) - beforeSell + r.gasUsed * r.gasPrice;
assert.ok(received >= sellMin, 'sell below minimum'); assert.equal(await weth.balanceOf(addresses[2]), 0n); assert.equal(await weth.balanceOf(M.router), 0n, 'WETH stuck in router');
log('sell', formatEther(sellIn), 'FORK ->', formatEther(received), 'ETH gas', gas.sell.toString());

// 7. Fees: collect through the locker; 10% treasury, 90% creator (default recipient), in WETH and FORK.
r = await tx(locker.collect(predicted)); gas.collect = r.gasUsed;
const tW = await locker.credit(addresses[4], M.weth), cW = await locker.credit(addresses[1], M.weth);
const tT = await locker.credit(addresses[4], predicted), cT = await locker.credit(addresses[1], predicted);
assert.ok(tW > 0n && cW > 0n && tT > 0n && cT > 0n);
assert.ok(cW >= tW * 9n - 9n && cW <= tW * 9n + 9n, '10/90 WETH split');
const volumeEth = parseEther('0.1') + buyIn; // ETH-side volume: initial buy + buy (sell pays fees in FORK)
const lpShare = (tW + cW) * 10000n / volumeEth;
log('collected WETH treasury', formatEther(tW), 'creator', formatEther(cW), '=> LP fee', lpShare.toString(), 'bp of ETH volume; FORK treasury', formatEther(tT));
r = await tx(locker.claim(M.weth, addresses[4])); gas.claim = r.gasUsed;
assert.equal(await weth.balanceOf(addresses[4]), tW);
await tx(locker.claim(M.weth, addresses[1])); assert.equal(await weth.balanceOf(addresses[1]), cW);
await rejects(locker.claim(M.weth, addresses[4]));

// 8. Gas station with real USDG: fresh wallet holding only USDG signs quote + permit(Global Dollar v1).
const station = await deploy('BitbankGasStation', [addresses[0], addresses[3], parseEther('0.05')]);
await tx(station.setAcceptedToken(M.usdg, true));
await tx(owner.sendTransaction({ to: station.target, value: parseEther('0.5') }));
const usdg = new Contract(M.usdg, erc20, provider);
await tx(router.connect(funder).multicall(await deadline(), [router.interface.encodeFunctionData('exactInputSingle', [{ tokenIn: M.weth, tokenOut: M.usdg, fee: 500, recipient: addresses[5], amountIn: parseEther('0.05'), amountOutMinimum: 0, sqrtPriceLimitX96: 0 }])], { value: parseEther('0.05') }));
const funderUsdg = await usdg.balanceOf(addresses[5]); assert.ok(funderUsdg > 0n);
const user = Wallet.createRandom(provider);
await tx(usdg.connect(funder).transfer(user.address, funderUsdg));
assert.equal(await provider.getBalance(user.address), 0n);
const tokenAmount = parseUnits('3', 6), ethAmount = parseEther('0.001'), dl = BigInt(Math.floor(Date.now() / 1000) + 600), quoteId = hexlify(randomBytes(32));
const permitSig = Signature.from(await user.signTypedData({ name: 'Global Dollar', version: '1', chainId, verifyingContract: M.usdg }, { Permit: [{ name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' }] }, { owner: user.address, spender: station.target, value: tokenAmount, nonce: await usdg.nonces(user.address), deadline: dl }));
const top = { user: user.address, token: M.usdg, tokenAmount, ethAmount, deadline: dl, quoteId };
const userSig = await user.signTypedData({ name: 'BitbankGasStation', version: '1', chainId, verifyingContract: station.target }, { TopUp: [{ name: 'user', type: 'address' }, { name: 'token', type: 'address' }, { name: 'tokenAmount', type: 'uint256' }, { name: 'ethAmount', type: 'uint256' }, { name: 'deadline', type: 'uint256' }, { name: 'quoteId', type: 'bytes32' }] }, top);
await rejects(station.connect(buyer).topUp(top, userSig, { deadline: dl, v: permitSig.v, r: permitSig.r, s: permitSig.s })); // not the relayer
r = await tx(station.connect(relayer).topUp(top, userSig, { deadline: dl, v: permitSig.v, r: permitSig.r, s: permitSig.s })); gas.topUp = r.gasUsed;
assert.equal(await provider.getBalance(user.address), ethAmount); assert.equal(await usdg.balanceOf(station.target), tokenAmount);
assert.equal(await usdg.allowance(user.address, station.target), 0n, 'permit consumed exactly');
await rejects(station.connect(relayer).topUp(top, userSig, { deadline: 0n, v: 27, r: permitSig.r, s: permitSig.s })); // replay
// Allowance path without permit: the user now has ETH to approve; a second quote uses permit.deadline == 0.
await tx(usdg.connect(user).approve(station.target, tokenAmount));
const top2 = { ...top, quoteId: hexlify(randomBytes(32)) };
const userSig2 = await user.signTypedData({ name: 'BitbankGasStation', version: '1', chainId, verifyingContract: station.target }, { TopUp: [{ name: 'user', type: 'address' }, { name: 'token', type: 'address' }, { name: 'tokenAmount', type: 'uint256' }, { name: 'ethAmount', type: 'uint256' }, { name: 'deadline', type: 'uint256' }, { name: 'quoteId', type: 'bytes32' }] }, top2);
await tx(station.connect(relayer).topUp(top2, userSig2, { deadline: 0n, v: 0, r: permitSig.r, s: permitSig.s }));
assert.equal(await usdg.balanceOf(station.target), tokenAmount * 2n);
await tx(station.withdraw(M.usdg, addresses[4], tokenAmount * 2n)); assert.equal(await usdg.balanceOf(addresses[4]), tokenAmount * 2n);
log('gas station: USDG permit (Global Dollar v1) and allowance top-ups passed; gas', gas.topUp.toString());

console.log(JSON.stringify({ chainId, pool, poolFeeProtocol: Number(slot0[5]), lpFeeBpOfEthVolume: Number(lpShare), gas: Object.fromEntries(Object.entries(gas).map(([k, v]) => [k, Number(v)])), pins: { router: keccak256(await provider.getCode(M.router)), quoter: keccak256(await provider.getCode(M.quoter)) } }, null, 1));
log('fork validation passed');
process.exit(0);
