/**
 * Anvil bootstrap. Stands up a complete, runnable instance of the system on a local
 * chain so the whole pipeline can be exercised from the terminal:
 *
 *   1. deploy two MockERC20 tokens (USDC/USDT stand-ins)
 *   2. deploy Registry + BatchDisperser (impl address predicted from nonce)
 *   3. EIP-7702-delegate the entry point and the approved source to the impl
 *   4. fund + mint tokens to every source; approve the impl for the approved source
 *   5. write `scenarios/anvil.json` describing the batch
 *
 * Uses the standard Anvil mnemonic, so keys are public and reproducible:
 *   index 0 → outer signer, 1 → entry point, 2..8 → authorities, 9 → approved source.
 *
 *   node --import tsx scripts/anvil-bootstrap.ts --rpc http://127.0.0.1:8545
 */

import {
  createPublicClient,
  createWalletClient,
  getContractAddress,
  http,
  parseEther,
  getAddress,
  type Address,
  type Hex,
} from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

const MNEMONIC = "test test test test test test test test test test test junk";
const acc = (i: number) => mnemonicToAccount(MNEMONIC, { addressIndex: i });

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}

function artifact(rel: string): { abi: unknown[]; bytecode: Hex } {
  const p = join(ROOT, "contracts/out", rel);
  const j = JSON.parse(readFileSync(p, "utf8")) as { abi: unknown[]; bytecode: { object: Hex } };
  return { abi: j.abi, bytecode: j.bytecode.object };
}

async function main(): Promise<void> {
  const rpcUrl = arg("rpc", process.env.ETH_RPC_URL ?? "http://127.0.0.1:8545");
  const transport = http(rpcUrl);
  const pub = createPublicClient({ chain: foundry, transport });
  const chainId = await pub.getChainId();

  const outerAcct = acc(0);
  const entryPointAcct = acc(1);
  const authorityAccts = [2, 3, 4, 5, 6, 7, 8].map(acc);
  const sourceAcct = acc(9);

  const wallet = createWalletClient({ account: outerAcct, chain: foundry, transport });

  // Fund the non-sender accounts so they can hold balances (outer already has ETH).
  for (const a of [...authorityAccts, sourceAcct]) {
    await wallet.sendTransaction({ to: a.address, value: parseEther("10") });
  }

  const usdcArt = artifact("MockERC20.sol/MockERC20.json");
  const regArt = artifact("Registry.sol/Registry.json");
  const implArt = artifact("BatchDisperser.sol/BatchDisperser.json");

  // ---- 1. tokens -----------------------------------------------------------
  const deployToken = async (name: string, symbol: string) => {
    const hash = await wallet.deployContract({
      abi: usdcArt.abi,
      bytecode: usdcArt.bytecode,
      args: [name, symbol, 6],
    });
    const rc = await pub.waitForTransactionReceipt({ hash });
    return getAddress(rc.contractAddress!);
  };
  const usdc = await deployToken("USD Coin", "USDC");
  const usdt = await deployToken("Tether USD", "USDT");

  // ---- 2. Registry + impl --------------------------------------------------
  const funderNonce = await pub.getTransactionCount({ address: outerAcct.address });
  // Registry is deployed at funderNonce, impl immediately after.
  const implAddr = getAddress(getContractAddress({ from: outerAcct.address, nonce: BigInt(funderNonce + 1) }));

  const sources = [...authorityAccts.map((a) => a.address), sourceAcct.address] as Address[];
  const regHash = await wallet.deployContract({
    abi: regArt.abi,
    bytecode: regArt.bytecode,
    args: [outerAcct.address, entryPointAcct.address, implAddr, sources, [usdc, usdt]],
  });
  const regRc = await pub.waitForTransactionReceipt({ hash: regHash });
  const registry = getAddress(regRc.contractAddress!);

  const implHash = await wallet.deployContract({
    abi: implArt.abi,
    bytecode: implArt.bytecode,
    args: [registry],
  });
  const implRc = await pub.waitForTransactionReceipt({ hash: implHash });
  const impl = getAddress(implRc.contractAddress!);
  if (impl.toLowerCase() !== implAddr.toLowerCase()) {
    throw new Error(`impl address mismatch: predicted ${implAddr} got ${impl}`);
  }

  // ---- 3. delegate entry point + approved source ---------------------------
  const delegate = async (acct: ReturnType<typeof mnemonicToAccount>) => {
    const nonce = await pub.getTransactionCount({ address: acct.address });
    const auth = await acct.signAuthorization!({ contractAddress: impl, chainId, nonce });
    const hash = await wallet.sendTransaction({
      to: acct.address,
      data: "0x",
      gas: 150_000n,
      authorizationList: [auth],
    } as never);
    await pub.waitForTransactionReceipt({ hash });
  };
  await delegate(entryPointAcct);
  await delegate(sourceAcct);

  // ---- 4. mint + approve ---------------------------------------------------
  const mint = async (token: Address, to: Address, amount: bigint) => {
    const hash = await wallet.writeContract({
      address: token,
      abi: usdcArt.abi,
      functionName: "mint",
      args: [to, amount],
    } as never);
    await pub.waitForTransactionReceipt({ hash });
  };

  const M = 1_000_000n; // 1 USDC/USDT in base units
  // Give every authority a healthy balance of both tokens.
  for (const a of authorityAccts) {
    await mint(usdc, a.address, 500n * M);
    await mint(usdt, a.address, 500n * M);
  }
  await mint(usdc, sourceAcct.address, 500n * M);
  await mint(usdt, sourceAcct.address, 500n * M);

  // Approved source approves the impl (planner gate for non-authority sources).
  const sw = createWalletClient({ account: sourceAcct, chain: foundry, transport });
  for (const token of [usdc, usdt]) {
    const hash = await sw.writeContract({
      address: token,
      abi: usdcArt.abi,
      functionName: "approve",
      args: [impl, 1_000_000n * M],
    } as never);
    await pub.waitForTransactionReceipt({ hash });
  }

  // ---- 5. scenario ---------------------------------------------------------
  // A 14-record batch: 6 USDC + 8 USDT, spread across the 7 authorities and the
  // approved source, each recipient distinct.
  const recipients = Array.from({ length: 14 }, (_, i) => acc(10 + i).address);
  const records: { source: number; token: Address; to: Address; amount: string }[] = [];
  for (let i = 0; i < 6; i++) {
    records.push({ source: i % 7, token: usdc, to: recipients[i]!, amount: String((i + 1) * 1000) });
  }
  for (let i = 0; i < 8; i++) {
    records.push({ source: i % 7, token: usdt, to: recipients[6 + i]!, amount: String((i + 1) * 1500) });
  }

  const scenario = {
    name: "anvil",
    chainId: String(chainId),
    entryPoint: entryPointAcct.address,
    outerSigner: outerAcct.address,
    delegationTarget: impl,
    tokens: [usdc, usdt],
    authorities: authorityAccts.map((a) => a.address),
    approvedSources: [sourceAcct.address],
    records,
    maxFeePerGas: "100000000000",
    maxPriorityFeePerGas: "1000000000",
    // Local chain: everything is cold on first touch, so the demo runs above the
    // reference's 600k cap. The reference conformance (predicted 510676 ≤ 600000) is
    // asserted in test/unit/gas.test.ts and the fork test.
    gasCap: "1500000",
  };

  const outPath = join(ROOT, "scenarios", "anvil.json");
  writeFileSync(outPath, JSON.stringify(scenario, null, 2) + "\n");

  // Keys are the public Anvil defaults, in index order 0..9.
  const rawKeys = [
    "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
    "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
    "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
    "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
    "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a",
    "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba",
    "0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e",
    "0x4bbbf85ce3377467afe5d46f804f221813b2bb87f24d81f60f1fcdbf7cbf4356",
    "0xdbda1821b80551c9d65939329250298aa3472ba22feea921c0cf5d620ea67b97",
    "0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6",
  ];
  const envPath = join(ROOT, "scenarios", "anvil.env");
  const finalEnv =
    [
      "# Generated by scripts/anvil-bootstrap.ts — PUBLIC anvil keys, do not reuse on mainnet.",
      `OUTER_SIGNER_KEY=${rawKeys[0]}`,
      `AUTHORITY_KEYS=${rawKeys.slice(2, 9).join(",")}`,
      `ETH_RPC_URL=${rpcUrl}`,
    ].join("\n") + "\n";
  writeFileSync(envPath, finalEnv);

  console.log("bootstrap OK");
  console.log("  chainId         :", chainId);
  console.log("  registry        :", registry);
  console.log("  delegationTarget:", impl);
  console.log("  USDC            :", usdc);
  console.log("  USDT            :", usdt);
  console.log("  entry point     :", entryPointAcct.address);
  console.log("  outer signer    :", outerAcct.address);
  console.log("  scenario        :", outPath);
  console.log("  env             :", envPath);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
