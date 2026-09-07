import assert from 'node:assert/strict';
import ganache from 'ganache';
import { BrowserProvider, ContractFactory, Contract, ZeroAddress, parseEther, randomBytes, hexlify, Signature, Wallet } from 'ethers';
import { compile, writeArtifacts } from './compile.mjs';

const { find } = compile({ dirs: ['src', 'test'] });
writeArtifacts(find);
const engine=ganache.provider({logging:{quiet:true},chain:{hardfork:'shanghai'},wallet:{totalAccounts:6}});
const provider=new BrowserProvider(engine, undefined, {cacheTimeout:-1});provider.pollingInterval=10;
const signers=await Promise.all([0,1,2,3,4].map(i=>provider.getSigner(i)));
const addresses=await Promise.all(signers.map(s=>s.getAddress()));
async function deploy(name,args=[],signer=signers[0]){const c=find(name);const contract=await new ContractFactory(c.abi,c.evm.bytecode.object,signer).deploy(...args);await contract.waitForDeployment();return contract;}
async function tx(p){return (await p).wait();}
async function rejects(p){await assert.rejects(async()=>{const result=await p;if(result?.wait)await result.wait();});}
const gas={};
try {
 const a=await deploy('MockAsset');const b=await deploy('MockAsset');
 await rejects(deploy('BitbankFeeSplitter',[[addresses[1]],[9999]]));
 await rejects(deploy('BitbankFeeSplitter',[[addresses[1],addresses[1]],[5000,5000]]));
 await rejects(deploy('BitbankFeeSplitter',[[ZeroAddress],[10000]]));
 const splitter=await deploy('BitbankFeeSplitter',[[addresses[1],addresses[2]],[6000,4000]]);
 await tx(a.mint(splitter.target,10000));
 assert.equal(await splitter.claimable(a.target,addresses[1]),6000n);
 await tx(splitter.connect(signers[3]).release(a.target,addresses[1]));
 assert.equal(await a.balanceOf(addresses[1]),6000n);assert.equal(await a.balanceOf(addresses[3]),0n);
 await rejects(splitter.release(a.target,addresses[1]));
 await tx(a.mint(splitter.target,10000));await tx(splitter.release(a.target,addresses[1]));await tx(splitter.release(a.target,addresses[2]));
 assert.equal(await a.balanceOf(addresses[1]),12000n);assert.equal(await a.balanceOf(addresses[2]),8000n);
 assert.equal(await a.balanceOf(splitter.target),0n);
 console.log('Splitter: immutable allocations, invalid recipients, cumulative deposits, replay and permissionless payout passed');

 const locker=await deploy('BitbankLaunchLocker',[addresses[0],addresses[4]]);
 const factory=await deploy('MockLaunchFactory');const manager=await deploy('MockManager',[locker.target,a.target,b.target]);
 await rejects(locker.connect(signers[1]).bindFactory(factory.target));await tx(locker.bindFactory(factory.target));await rejects(locker.bindFactory(factory.target));
 await rejects(factory.setup(locker.target,a.target,b.target,manager.target,addresses[1],3000));
 await tx(factory.setup(locker.target,a.target,b.target,manager.target,addresses[1],10000));
 await rejects(locker.setFeeRedirect(a.target,addresses[3]));
 await tx(factory.redirect(locker.target,a.target,splitter.target));await rejects(factory.redirect(locker.target,a.target,addresses[3]));
 await tx(manager.setAmount(1));
 for(let i=0;i<10;i++)await tx(locker.collect(a.target));
 assert.equal(await locker.credit(addresses[4],a.target),1n);assert.equal(await locker.credit(splitter.target,a.target),9n);
 await tx(manager.setAmount(9990));await tx(locker.collect(a.target));
 assert.equal(await locker.credit(addresses[4],a.target),1000n);assert.equal(await locker.credit(splitter.target,a.target),9000n);
 assert.equal(await locker.owed(a.target),10000n);
 await rejects(locker.sync(a.target)); // nothing unaccounted
 await tx(a.mint(locker.target,50)); // donation / sniper fee style arrival
 await tx(locker.sync(a.target));assert.equal(await locker.credit(addresses[4],a.target),1005n);assert.equal(await locker.credit(splitter.target,a.target),9045n);
 await tx(locker.connect(signers[3]).claim(a.target,splitter.target));
 assert.equal(await a.balanceOf(splitter.target),9045n);assert.equal(await a.balanceOf(addresses[3]),0n);
 await rejects(locker.claim(a.target,splitter.target));
 await tx(locker.claim(a.target,addresses[4]));assert.equal(await a.balanceOf(addresses[4]),1005n);assert.equal(await locker.owed(a.target),0n);
 await tx(splitter.release(a.target,addresses[1]));await tx(splitter.release(a.target,addresses[2]));
 assert.equal(await a.balanceOf(addresses[1]),17427n);assert.equal(await a.balanceOf(addresses[2]),11618n);
 console.log('Locker: one-time binding, 1% pool guard, immutable redirect, fragmented collection, sync, 10/90 accounting and pull claims passed');

 // End-to-end launch against a mock V3 stack.
 const weth=await deploy('MockWETH');const dex=await deploy('MockDex',[weth.target]);const treasury=addresses[4];
 const locker2=await deploy('BitbankLaunchLocker',[addresses[0],treasury]);
 const launchFee=parseEther('0.01');
 const launch=await deploy('BitbankLaunchFactory',[addresses[0],locker2.target,launchFee]);
 assert.equal(await launch.protocolFeeRecipient(),treasury);
 await tx(locker2.bindFactory(launch.target));
 await rejects(launch.addDexConfig([dex.target,dex.target,dex.target,3000,60,true]));
 await tx(launch.addDexConfig([dex.target,dex.target,dex.target,10000,200,true]));
 assert.equal(await launch.dexConfigCount(),1n);
 const supply=parseEther('1000000');
 const launchConfig=(tick,sniper=9000,blocks=3)=>[weth.target,tick,500,550,blocks,sniper,true,true,supply];
 await rejects(launch.addLaunchConfig(launchConfig(-100100)));
 await rejects(launch.addLaunchConfig(launchConfig(-100000,10001)));
 await rejects(launch.addLaunchConfig(launchConfig(-100000,9000,0)));
 await tx(launch.addLaunchConfig(launchConfig(-100000)));
 await tx(launch.addLaunchConfig(launchConfig(-100000,0,0))); // preset 1: no restrictions at all
 assert.equal(await launch.launchConfigCount(),2n);
 const params=(feeWallet=splitter.target,sniperFeeDisabled=false)=>['Builders','BUILD','ipfs://logo','desc',['','','','https://b.example',''],feeWallet,sniperFeeDisabled];
 const creator=signers[1];const salt=hexlify(randomBytes(32));
 await rejects(launch.connect(creator).launchToken(params(),0,0,salt,{value:launchFee})); // launches closed
 await tx(launch.setLaunchEnabled(true));
 await rejects(launch.connect(creator).launchToken(params(),0,0,salt,{value:launchFee-1n}));
 await rejects(launch.connect(creator).launchToken(['','BUILD','','',['','','','',''],ZeroAddress,false],0,0,salt,{value:launchFee}));
 const predicted=await launch.predictTokenAddress(params(),0,0,salt,addresses[1]);
 await tx(dex.setTokensOut(parseEther('100000'))); // 10% initial buy, above the 5% wallet cap: creator exemption
 await tx(dex.setBuyRecipient(addresses[2]));
 await rejects(launch.connect(creator).launchToken(params(),0,0,salt,{value:launchFee+parseEther('1')})); // launch-block buy to a stranger is blocked
 await tx(dex.setBuyRecipient(ZeroAddress));
 const treasuryBefore=await provider.getBalance(treasury);
 const receipt=await tx(launch.connect(creator).launchToken(params(),0,0,salt,{value:launchFee+parseEther('1')}));
 gas.launchWithInitialBuy=receipt.gasUsed;
 const launchBlock=BigInt(receipt.blockNumber);
 assert.equal((await provider.getBalance(treasury))-treasuryBefore,launchFee);
 const token=new Contract(predicted,find('BitbankLauncherToken').abi,provider);
 assert.equal(await token.balanceOf(addresses[1]),parseEther('100000'));
 assert.equal(await token.deployer(),addresses[1]);assert.equal(await token.locker(),locker2.target);assert.equal(await token.sniperFeeBps(),9000n);
 const pool=await dex.getPool(predicted,weth.target,10000);
 assert.equal(await token.pool(),pool);assert.equal(await token.liquidityPool(),pool);
 assert.equal(await token.balanceOf(pool),supply-parseEther('100000'));
 assert.equal(await dex.ownerOf(1),locker2.target);
 const record=await launch.getLaunchedToken(predicted);
 assert.equal(record.exists,true);assert.equal(record.positionId,1n);assert.equal(record.deployer,addresses[1]);assert.equal(record.pairedToken,weth.target);
 assert.equal(record.supply,supply);assert.equal(record.poolFee,10000n);assert.equal(record.initialBuyAmount,parseEther('1'));assert.equal(record.restrictionsEndBlock,launchBlock+3n);
 assert.equal(record.isToken0,BigInt(predicted)<BigInt(weth.target));
 const position=await locker2.positions(predicted);assert.equal(position[4],splitter.target);assert.equal(position[1],1n);
 const info=await token.getTokenInfo();assert.equal(info[1],'ipfs://logo');assert.equal(info[3][3],'https://b.example');
 const empty=await launch.getLaunchedToken(addresses[3]);assert.equal(empty.exists,false);

 // Sniper fee decays linearly: 9000 bps at launch, zero at restrictionsEndBlock.
 const feeAt=bn=>bn>launchBlock&&bn<=launchBlock+3n?9000n*(launchBlock+3n-bn)/3n:0n;
 const sniper=addresses[2];
 assert.equal(await token.buyFeeBps(),0n); // launch block context
 let r=await tx(dex.buyFrom(pool,predicted,sniper,parseEther('10000')));gas.sniperBuy=r.gasUsed;
 let bn=BigInt(r.blockNumber);assert.equal(bn,launchBlock+1n);
 let fee=parseEther('10000')*feeAt(bn)/10000n;assert.equal(fee,parseEther('6000'));
 assert.equal(await token.balanceOf(sniper),parseEther('4000'));assert.equal(await token.balanceOf(locker2.target),fee);
 await tx(locker2.sync(predicted));
 assert.equal(await locker2.credit(treasury,predicted),fee/10n);assert.equal(await locker2.credit(splitter.target,predicted),fee*9n/10n);
 await rejects(locker2.sync(predicted));
 bn=BigInt(await provider.getBlockNumber())+1n;const fee2=feeAt(bn);
 // Wallet cap 5% (50,000) and cumulative cap 5.5% apply to post-fee amounts.
 const big=parseEther('50000')*10000n/(10000n-fee2)+parseEther('1');
 await rejects(dex.buyFrom(pool,predicted,sniper,big)); // MaxWalletExceeded
 bn=BigInt(await provider.getBlockNumber())+1n;
 if(feeAt(bn)===0n){ await rejects(dex.buyFrom(pool,predicted,sniper,parseEther('60000'))); }
 // Advance beyond the window: no fee, no caps, plain transfers.
 while(BigInt(await provider.getBlockNumber())<launchBlock+3n)await tx(signers[3].sendTransaction({to:addresses[3],value:0}));
 assert.equal(await token.buyFeeBps(),0n);
 r=await tx(dex.buyFrom(pool,predicted,addresses[3],parseEther('200000')));gas.normalBuy=r.gasUsed;
 assert.equal(await token.balanceOf(addresses[3]),parseEther('200000'));
 r=await tx(token.connect(signers[3]).transfer(addresses[2],parseEther('1')));gas.transfer=r.gasUsed;
 await rejects(launch.connect(creator).launchToken(params(),0,0,salt,{value:launchFee})); // salt reuse by the same creator
 const other=await launch.predictTokenAddress(params(),0,0,salt,addresses[2]);assert.notEqual(other,predicted); // salt is scoped by creator
 await tx(launch.connect(signers[2]).launchToken(params(),0,0,salt,{value:launchFee}));
 // Pool fees flow through collect -> claim -> release.
 await tx(dex.setFeeAmount(1000));await tx(locker2.collect(predicted));
 assert.equal(await locker2.credit(treasury,weth.target),100n);assert.equal(await locker2.credit(splitter.target,weth.target),900n);
 await tx(locker2.claim(weth.target,splitter.target));assert.equal(await weth.balanceOf(splitter.target),900n);
 await tx(locker2.claim(predicted,splitter.target));assert.equal(await token.balanceOf(splitter.target),fee*9n/10n);
 await tx(splitter.release(predicted,addresses[1]));assert.equal(await token.balanceOf(addresses[1]),parseEther('100000')+fee*9n/10n*6000n/10000n);

 // Creator opt-out: sniper fee disabled but caps still apply. Preset 1: nothing restricted, no initial buy, creator payout.
 const salt2=hexlify(randomBytes(32));const predicted2=await launch.predictTokenAddress(params(ZeroAddress,true),0,0,salt2,addresses[1]);
 r=await tx(launch.connect(creator).launchToken(params(ZeroAddress,true),0,0,salt2,{value:launchFee}));gas.launchNoInitialBuy=r.gasUsed;
 const token2=new Contract(predicted2,find('BitbankLauncherToken').abi,provider);
 assert.equal(await token2.sniperFeeBps(),0n);assert.equal(await token2.buyFeeBps(),0n);
 assert.equal((await locker2.positions(predicted2))[4],addresses[1]);
 const pool2=await token2.pool();
 await tx(dex.buyFrom(pool2,predicted2,sniper,parseEther('10000')));assert.equal(await token2.balanceOf(sniper),parseEther('10000'));
 await rejects(dex.buyFrom(pool2,predicted2,sniper,parseEther('50000')));
 const salt3=hexlify(randomBytes(32));const predicted3=await launch.predictTokenAddress(params(),1,0,salt3,addresses[1]);
 await tx(dex.createPool(predicted3,weth.target,10000)); // pre-created pool griefing is rejected
 await rejects(launch.connect(creator).launchToken(params(),1,0,salt3,{value:launchFee}));
 const salt4=hexlify(randomBytes(32));const predicted4=await launch.predictTokenAddress(params(),1,0,salt4,addresses[1]);
 await tx(launch.connect(creator).launchToken(params(),1,0,salt4,{value:launchFee}));
 const token4=new Contract(predicted4,find('BitbankLauncherToken').abi,provider);
 await tx(dex.buyFrom(await token4.pool(),predicted4,sniper,parseEther('300000')));assert.equal(await token4.balanceOf(sniper),parseEther('300000'));
 // Whitelist path and fee transfer failure.
 await tx(launch.setLaunchEnabled(false));
 await rejects(launch.connect(creator).launchToken(params(),0,0,hexlify(randomBytes(32)),{value:launchFee}));
 await tx(launch.setWhitelistedLauncher(addresses[1],true));
 await tx(launch.connect(creator).launchToken(params(),0,0,hexlify(randomBytes(32)),{value:launchFee}));
 const reject=await deploy('RejectEth');const locker3=await deploy('BitbankLaunchLocker',[addresses[0],reject.target]);
 const launch3=await deploy('BitbankLaunchFactory',[addresses[0],locker3.target,launchFee]);
 await tx(locker3.bindFactory(launch3.target));await tx(launch3.addDexConfig([dex.target,dex.target,dex.target,10000,200,true]));await tx(launch3.addLaunchConfig(launchConfig(-100000)));await tx(launch3.setLaunchEnabled(true));
 await rejects(launch3.connect(creator).launchToken(params(),0,0,hexlify(randomBytes(32)),{value:launchFee}));
 console.log('Factory: end-to-end launch, treasury fee, creator initial buy, launch-block block, pool cache, packed record, sniper fee decay + sync, caps, opt-out, pre-created pool, whitelist, fee failure passed');
 console.log('Gas:',Object.fromEntries(Object.entries(gas).map(([k,v])=>[k,Number(v)])));

 const usdc=await deploy('MockPermitToken');
 const relayer=signers[3]; const accounts=engine.getInitialAccounts(); const user=new Wallet(accounts[addresses[2].toLowerCase()].secretKey, provider);
 const station=await deploy('BitbankGasStation',[addresses[0],addresses[3],parseEther('0.05')]);
 await rejects(deploy('BitbankGasStation',[addresses[0],ZeroAddress,parseEther('0.05')]));
 await tx(signers[0].sendTransaction({to:station.target,value:parseEther('1')}));
 await tx(usdc.mint(addresses[2],10_000_000n));
 const chainId=(await provider.getNetwork()).chainId;
 const domain={name:'BitbankGasStation',version:'1',chainId,verifyingContract:station.target};
 const types={TopUp:[{name:'user',type:'address'},{name:'token',type:'address'},{name:'tokenAmount',type:'uint256'},{name:'ethAmount',type:'uint256'},{name:'deadline',type:'uint256'},{name:'quoteId',type:'bytes32'}]};
 const permitTypes={Permit:[{name:'owner',type:'address'},{name:'spender',type:'address'},{name:'value',type:'uint256'},{name:'nonce',type:'uint256'},{name:'deadline',type:'uint256'}]};
 const permitDomain={name:'USD Coin',version:'1',chainId,verifyingContract:usdc.target};
 const now=(await provider.getBlock('latest')).timestamp;
 const quote={user:addresses[2],token:usdc.target,tokenAmount:56334n,ethAmount:parseEther('0.00002'),deadline:now+600,quoteId:hexlify(randomBytes(32))};
 const userSig=await user.signTypedData(domain,types,quote);
 const permitSig=Signature.from(await user.signTypedData(permitDomain,permitTypes,{owner:addresses[2],spender:station.target,value:quote.tokenAmount,nonce:0n,deadline:now+600}));
 const permit=[now+600,permitSig.v,permitSig.r,permitSig.s];
 await rejects(station.connect(relayer).topUp(quote,userSig,permit)); // token not accepted yet
 await tx(station.setAcceptedToken(usdc.target,true));
 await rejects(station.connect(user).topUp(quote,userSig,permit)); // not relayer
 await rejects(station.connect(relayer).topUp({...quote,ethAmount:quote.ethAmount+1n},userSig,permit)); // tampered amount
 const before=await provider.getBalance(addresses[2]);
 await tx(station.connect(relayer).topUp(quote,userSig,permit));
 assert.equal(await usdc.balanceOf(addresses[2]),10_000_000n-56334n);assert.equal(await usdc.balanceOf(station.target),56334n);
 assert.equal((await provider.getBalance(addresses[2]))-before,quote.ethAmount);
 await rejects(station.connect(relayer).topUp(quote,userSig,permit)); // replay
 const second={...quote,quoteId:hexlify(randomBytes(32))};
 const noPermit=[0,0,'0x'+'0'.repeat(64),'0x'+'0'.repeat(64)];
 await rejects(station.connect(relayer).topUp(second,userSig,noPermit)); // signature bound to quote id
 const secondSig=await user.signTypedData(domain,types,second);
 await rejects(station.connect(relayer).topUp(second,secondSig,noPermit)); // no allowance, no permit
 await tx(usdc.connect(user).approve(station.target,56334n));
 await tx(station.connect(relayer).topUp(second,secondSig,noPermit)); // existing allowance path
 const big2={...quote,quoteId:hexlify(randomBytes(32)),ethAmount:parseEther('0.06')};
 await rejects(station.connect(relayer).topUp(big2,await user.signTypedData(domain,types,big2),noPermit));
 const expired={...quote,quoteId:hexlify(randomBytes(32)),deadline:now-1};
 await rejects(station.connect(relayer).topUp(expired,await user.signTypedData(domain,types,expired),noPermit));
 await rejects(station.connect(user).withdraw(usdc.target,addresses[2],1n));
 await tx(station.withdraw(usdc.target,addresses[4],112668n));assert.equal(await usdc.balanceOf(addresses[4]),112668n);
 await tx(station.withdraw(ZeroAddress,addresses[4],parseEther('0.5')));
 console.log('Gas station: EIP-712 quote binding, permit and allowance paths, replay, tamper, cap, expiry, relayer and owner controls passed');
} finally { await engine.disconnect(); }
