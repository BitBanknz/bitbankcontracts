import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import solc from 'solc';
import ganache from 'ganache';
import { BrowserProvider, ContractFactory, ZeroAddress } from 'ethers';

const sources = {};
function walk(dir) { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = `${dir}/${e.name}`; if (e.isDirectory()) walk(p); else if (p.endsWith('.sol')) sources[p] = { content: fs.readFileSync(p, 'utf8') }; } }
walk('src'); walk('test');
const output = JSON.parse(solc.compile(JSON.stringify({ language:'Solidity', sources, settings:{ optimizer:{enabled:true,runs:200}, viaIR:true, evmVersion:'shanghai', outputSelection:{'*':{'*':['abi','evm.bytecode.object','evm.deployedBytecode.object']}} } }), { import: name => {
 const p = name.replace('@openzeppelin/contracts/', 'lib/openzeppelin-contracts/contracts/');
 return fs.existsSync(p) ? { contents:fs.readFileSync(p,'utf8') } : { error:`Missing ${name}` };
} }));
for (const error of output.errors || []) if (error.severity === 'error') console.error(error.formattedMessage);
assert(!(output.errors || []).some(e => e.severity === 'error'), 'Solidity compilation failed');
const find = name => { for (const contracts of Object.values(output.contracts)) if (contracts[name]) return contracts[name]; throw new Error(name); };
fs.mkdirSync('out',{recursive:true});
for (const name of ['BitbankFeeSplitter','BitbankLaunchLocker','BitbankLaunchFactory']) {
 const c=find(name); const bytes=c.evm.deployedBytecode.object.length/2;
 assert(bytes <= 24576,`${name} exceeds EIP-170 (${bytes} bytes)`);
 fs.writeFileSync(`out/${name}.json`,JSON.stringify({contractName:name,abi:c.abi,bytecode:'0x'+c.evm.bytecode.object,deployedBytecode:'0x'+c.evm.deployedBytecode.object},null,2));
 console.log(`${name}: compiled, ${bytes} deployed bytes`);
}
const engine=ganache.provider({logging:{quiet:true},chain:{hardfork:'shanghai'},wallet:{totalAccounts:6}});
const provider=new BrowserProvider(engine, undefined, {cacheTimeout:-1});provider.pollingInterval=10;
const signers=await Promise.all([0,1,2,3,4].map(i=>provider.getSigner(i)));
const addresses=await Promise.all(signers.map(s=>s.getAddress()));
async function deploy(name,args=[]){const c=find(name);const contract=await new ContractFactory(c.abi,c.evm.bytecode.object,signers[0]).deploy(...args);await contract.waitForDeployment();return contract;}
async function tx(p){await(await p).wait();}
async function rejects(p){await assert.rejects(async()=>{const result=await p;if(result?.wait)await result.wait();});}
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
 console.log('Splitter: immutable allocations, invalid recipients, cumulative deposits, replay and permissionless payout tests passed');
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
 await tx(locker.connect(signers[3]).claim(a.target,splitter.target));
 assert.equal(await a.balanceOf(splitter.target),9000n);assert.equal(await a.balanceOf(addresses[3]),0n);
 await rejects(locker.claim(a.target,splitter.target));
 await tx(locker.claim(a.target,addresses[4]));assert.equal(await a.balanceOf(addresses[4]),1000n);
 await tx(splitter.release(a.target,addresses[1]));await tx(splitter.release(a.target,addresses[2]));
 assert.equal(await a.balanceOf(addresses[1]),17400n);assert.equal(await a.balanceOf(addresses[2]),11600n);
 console.log('Locker: one-time binding, 1% pool guard, immutable redirect, fragmented collection, 10/90 accounting and pull claims passed');
 const launch=await deploy('BitbankLaunchFactory',[addresses[0],locker.target,0]);
 await rejects(launch.addDexConfig(['wrong fee',factory.target,manager.target,addresses[1],3000,60,true]));
 await tx(launch.addDexConfig(['V3',factory.target,manager.target,addresses[1],10000,200,true]));
 assert.equal(await launch.dexConfigCount(),1n);
 console.log('Factory: deployment and enforced 1% pool fee passed');
} finally { await engine.disconnect(); }
