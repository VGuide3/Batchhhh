/**
 * viem-backed `ChainPort`. Wraps a public client (reads) and a wallet client (the
 * outer signer, for sends). No business logic lives here — only transport.
 */

import {
  createPublicClient,
  createWalletClient,
  getAddress,
  http,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
  type Transport,
  type Chain,
} from "viem";
import type { PrivateKeyAccount } from "viem/accounts";
import type { ChainPort, NodeReceipt, SendType4Request } from "./port.js";
import type { RawLog } from "../exec/reconciler.js";

const ERC20_ABI = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

export interface ViemChainPortOptions {
  readonly rpcUrl: string;
  readonly chain: Chain;
  readonly account: PrivateKeyAccount;
}

export class ViemChainPort implements ChainPort {
  private readonly publicClient: PublicClient;
  private readonly walletClient: WalletClient<Transport, Chain, PrivateKeyAccount>;

  constructor(opts: ViemChainPortOptions) {
    const transport = http(opts.rpcUrl);
    this.publicClient = createPublicClient({ chain: opts.chain, transport }) as PublicClient;
    this.walletClient = createWalletClient({
      account: opts.account,
      chain: opts.chain,
      transport,
    });
  }

  async chainId(): Promise<bigint> {
    return BigInt(await this.publicClient.getChainId());
  }

  async blockNumber(): Promise<bigint> {
    return this.publicClient.getBlockNumber();
  }

  async baseFeePerGas(): Promise<bigint> {
    const block = await this.publicClient.getBlock({ blockTag: "latest" });
    return block.baseFeePerGas ?? 1_000_000_000n;
  }

  async getTransactionCount(
    address: Address,
    blockTag: bigint | "latest" | "pending" = "latest",
  ): Promise<number> {
    return this.publicClient.getTransactionCount({ address, blockTag: blockTag as never });
  }

  async codeLength(address: Address): Promise<number> {
    const code = await this.publicClient.getCode({ address });
    return code ? (code.length - 2) / 2 : 0;
  }

  async erc20Balance(token: Address, account: Address): Promise<bigint> {
    return this.publicClient.readContract({
      address: token,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [account],
    });
  }

  async erc20Allowance(token: Address, owner: Address, spender: Address): Promise<bigint> {
    return this.publicClient.readContract({
      address: token,
      abi: ERC20_ABI,
      functionName: "allowance",
      args: [owner, spender],
    });
  }

  async estimateGas(req: SendType4Request): Promise<bigint> {
    return this.publicClient.estimateGas({
      account: this.walletClient.account,
      to: req.to,
      data: req.data,
      authorizationList: req.authorizationList.map(toViemAuth),
    });
  }

  async sendType4(req: SendType4Request): Promise<Hex> {
    return this.walletClient.sendTransaction({
      account: this.walletClient.account,
      chain: this.walletClient.chain,
      to: req.to,
      data: req.data,
      authorizationList: req.authorizationList.map(toViemAuth),
      gas: req.gas,
      maxFeePerGas: req.maxFeePerGas,
      maxPriorityFeePerGas: req.maxPriorityFeePerGas,
      nonce: req.nonce,
    } as never);
  }

  async waitForReceipt(hash: Hex): Promise<NodeReceipt> {
    const rc = await this.publicClient.waitForTransactionReceipt({ hash });
    return {
      status: rc.status === "success" ? 1 : 0,
      type: typeToNumber(rc.type),
      gasUsed: rc.gasUsed,
      effectiveGasPrice: rc.effectiveGasPrice ?? 0n,
      logs: rc.logs.map(
        (l): RawLog => ({
          address: getAddress(l.address),
          topics: l.topics as readonly Hex[],
          data: (l.data ?? "0x") as Hex,
        }),
      ),
      authorizationList:
        (rc as { authorizationList?: { address: Address; recovered?: Address }[] })
          .authorizationList?.map((a) => ({
            address: getAddress(a.address),
            recovered: getAddress(a.recovered ?? a.address),
          })) ?? [],
    };
  }

  async delegationTargetOf(account: Address): Promise<Address | null> {
    const code = await this.publicClient.getCode({ address: account });
    if (!code || code.length < 2 + 46) return null;
    if (!code.toLowerCase().startsWith("0xef0100")) return null;
    const target = `0x${code.slice(8, 48)}`;
    return getAddress(target);
  }
}

function toViemAuth(a: {
  chainId: bigint;
  address: Hex;
  nonce: bigint;
  yParity: 0 | 1;
  r: Hex;
  s: Hex;
}) {
  return {
    chainId: Number(a.chainId),
    address: a.address,
    nonce: Number(a.nonce),
    yParity: a.yParity,
    r: a.r,
    s: a.s,
  };
}

function typeToNumber(type: string | undefined): number {
  switch (type) {
    case "legacy":
      return 0;
    case "eip2930":
      return 1;
    case "eip1559":
      return 2;
    case "eip4844":
      return 3;
    case "eip7702":
      return 4;
    default:
      return 0;
  }
}
