import fs from 'node:fs';
import solc from 'solc';

export const EIP170 = 24576;
export const ARTIFACTS = ['BitbankFeeSplitter', 'BitbankLaunchLocker', 'BitbankLaunchFactory', 'BitbankGasStation', 'BitbankLauncherToken'];

export function compile({ evmVersion = 'shanghai', dirs = ['src'] } = {}) {
  const sources = {};
  const walk = dir => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = `${dir}/${e.name}`; if (e.isDirectory()) walk(p); else if (p.endsWith('.sol')) sources[p] = { content: fs.readFileSync(p, 'utf8') }; } };
  dirs.forEach(walk);
  const output = JSON.parse(solc.compile(JSON.stringify({ language: 'Solidity', sources, settings: { optimizer: { enabled: true, runs: 200 }, viaIR: true, evmVersion, outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object'] } } } }), { import: name => {
    const p = name.replace('@openzeppelin/contracts/', 'lib/openzeppelin-contracts/contracts/');
    return fs.existsSync(p) ? { contents: fs.readFileSync(p, 'utf8') } : { error: `Missing ${name}` };
  } }));
  for (const error of output.errors || []) if (error.severity === 'error') console.error(error.formattedMessage);
  if ((output.errors || []).some(e => e.severity === 'error')) throw new Error('Solidity compilation failed');
  const find = name => { for (const contracts of Object.values(output.contracts)) if (contracts[name]) return contracts[name]; throw new Error(name); };
  return { output, find };
}

export function writeArtifacts(find) {
  fs.mkdirSync('out', { recursive: true });
  for (const name of ARTIFACTS) {
    const c = find(name); const bytes = c.evm.deployedBytecode.object.length / 2;
    if (bytes > EIP170) throw new Error(`${name} exceeds EIP-170 (${bytes} bytes)`);
    fs.writeFileSync(`out/${name}.json`, JSON.stringify({ contractName: name, abi: c.abi, bytecode: '0x' + c.evm.bytecode.object, deployedBytecode: '0x' + c.evm.deployedBytecode.object }, null, 2));
    console.log(`${name}: compiled, ${bytes} deployed bytes`);
  }
}
