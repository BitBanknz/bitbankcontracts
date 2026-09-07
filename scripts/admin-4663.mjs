// Owner actions on the live 4663 deployment, signed with .deployerkey (the owner wallet).
// Usage: node scripts/admin-4663.mjs <status|whitelist <addr> <1|0>|enable <1|0>|set-launch-fee <wei>|station-max-eth <wei>|station-relayer <addr>|withdraw <asset|eth> <to> <amount>>
import fs from 'node:fs';
import { JsonRpcProvider, Wallet, Contract, ZeroAddress, formatEther } from 'ethers';
const m = JSON.parse(fs.readFileSync('out/deployment-4663.json', 'utf8'));
const provider = new JsonRpcProvider(m.rpc_url, m.chain_id, { staticNetwork: true });
const key = fs.readFileSync('.deployerkey', 'utf8').trim();
const wallet = new Wallet(key, provider);
const abi = n => JSON.parse(fs.readFileSync(`out/${n}.json`, 'utf8')).abi;
const factory = new Contract(m.factory.address, abi('BitbankLaunchFactory'), wallet);
const locker = new Contract(m.locker.address, abi('BitbankLaunchLocker'), wallet);
const station = new Contract(m.gas_station.contract.address, abi('BitbankGasStation'), wallet);
const [cmd, ...a] = process.argv.slice(2);
const send = async (label, p) => { const tx = await p; console.log(label, tx.hash); const r = await tx.wait(); console.log('  status', r.status, 'gas', r.gasUsed.toString()); };
if (cmd === 'status' || !cmd) {
  console.log('owner', wallet.address, 'balance', formatEther(await provider.getBalance(wallet.address)));
  console.log('factory.owner', await factory.owner(), 'launchEnabled', await factory.launchEnabled(), 'launchFee', (await factory.launchFee()).toString());
  console.log('whitelisted(owner)', await factory.whitelistedLaunchers(wallet.address));
  console.log('locker.owner', await locker.owner(), 'factory', await locker.factory(), 'treasury', await locker.protocolFeeRecipient());
  console.log('station.owner', await station.owner(), 'relayer', await station.relayer(), 'maxEth', formatEther(await station.maxEthPerTopUp()), 'balance', formatEther(await provider.getBalance(m.gas_station.contract.address)));
  console.log('relayer balance', formatEther(await provider.getBalance(await station.relayer())));
} else if (cmd === 'whitelist') await send(`setWhitelistedLauncher(${a[0]}, ${a[1]})`, factory.setWhitelistedLauncher(a[0], a[1] === '1'));
else if (cmd === 'enable') await send(`setLaunchEnabled(${a[0]})`, factory.setLaunchEnabled(a[0] === '1'));
else if (cmd === 'set-launch-fee') await send(`setLaunchFee(${a[0]})`, factory.setLaunchFee(BigInt(a[0])));
else if (cmd === 'station-max-eth') await send(`setMaxEthPerTopUp(${a[0]})`, station.setMaxEthPerTopUp(BigInt(a[0])));
else if (cmd === 'station-relayer') await send(`setRelayer(${a[0]})`, station.setRelayer(a[0]));
else if (cmd === 'withdraw') await send(`withdraw(${a[0]}, ${a[1]}, ${a[2]})`, station.withdraw(a[0] === 'eth' ? ZeroAddress : a[0], a[1], BigInt(a[2])));
else { console.error('unknown command'); process.exit(2); }
