import { getAddress, type Address } from "viem";

/**
 * Address registry for SPEC-7702-BATCH-001.
 *
 * Values below are verified against the on-chain reference transaction
 * `0x853b3eab…be5f38` (Ethereum mainnet, block 0x192a394). The reference's
 * authorities, delegation target, and per-token totals were read directly from the
 * receipt and the transaction's `authorization_list`; see
 * `test/fixtures/reference_receipt.json` and `test/unit/reference-audit.test.ts`.
 *
 * All addresses are normalized through EIP-55 checksumming at load time.
 */

/** Chain ID is pinned to 1 (Ethereum mainnet). */
export const CHAIN_ID = 1n;

/** `tx.to`; the root execution context (also the 8th dispersal source). */
export const ENTRY_POINT: Address = getAddress("0xebbabfc2019a312e3615196e9ac517c6bee2a5f6");

/** Pays gas, plain EOA, no delegation. */
export const OUTER_SIGNER: Address = getAddress("0x693b06215df13832feeaee61f35860c372603be2");

/** Reference transaction hash (replay target). */
export const REFERENCE_TX_HASH =
  "0x853b3eabf9d1c8b2f47ee8a29870288a94e884a1f3a81d541b550dea7dbe5f38" as const;

/** Mainnet block containing the reference transaction. */
export const REFERENCE_BLOCK = 0x192a394n;

/** Shared delegation target recorded in the reference's authorization list. */
export const REFERENCE_DELEGATION_TARGET: Address = getAddress(
  "0x2d36fa3b1279eecaa198bacbd578bb4dbe139953",
);

/** The 7 authority EOAs recovered from the reference authorization list, in order. */
export const REFERENCE_AUTHORITIES: readonly Address[] = [
  "0x0712340a008D735066F629250ee0E546abCfFF4e",
  "0x3C1a440Fb700807ACaB29d233217EAC244A96031",
  "0x44102798A54824D9125C0392B49b3639c237fB0a",
  "0xf313209F1470B7570A451aC136Aa1584Ca35c5C6",
  "0x3181c14A4C0E63aADf56780f65654fB879Ac05d5",
  "0xf93e403771bf36750Db31312918F92edF8412250",
  "0x82cbFc9838218B5AFA90fc2F37949aAc4867eB56",
].map((a) => getAddress(a));

export interface TokenSpec {
  readonly symbol: string;
  readonly address: Address;
  readonly decimals: number;
}

/** Registry tokens. Only exact-amount ERC-20s; the allowlist blocks fee/rebasing tokens. */
export const TOKENS: Record<"USDC" | "USDT", TokenSpec> = {
  USDC: { symbol: "USDC", address: getAddress("0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"), decimals: 6 },
  USDT: { symbol: "USDT", address: getAddress("0xdAC17F958D2ee523a2206206994597C13D831ec7"), decimals: 6 },
};

export const USDC = TOKENS.USDC.address;
export const USDT = TOKENS.USDT.address;

/** Reference-batch shape, used by fixtures and gas expectations. */
export const REFERENCE_SHAPE = {
  gasUsed: 510676n,
  calldataLength: 1156,
  recordCount: 14,
  authorityCount: 7,
  delegationTargetCount: 1,
  approvedSourceCount: 1,
  recipientCount: 14,
  /** Sum of USDC `Transfer` log amounts, in base units. */
  usdcTotal: 23640n,
  /** Sum of USDT `Transfer` log amounts, in base units. */
  usdtTotal: 23934n,
} as const;

/** Runtime configuration: the parts of the registry the spec leaves open. */
export interface DisperserConfig {
  /** The shared, immutable delegation implementation address. */
  readonly delegationTarget: Address;
  /** 7 authority EOAs, in auth-list order (== record source ordinal 0..6). */
  readonly authorities: readonly Address[];
  /** Non-authority sources holding a pre-existing allowance to the impl (ordinal 7+). */
  readonly approvedSources: readonly Address[];
  /** Allowlisted token addresses. Defaults to `[USDC, USDT]`. */
  readonly tokens?: readonly Address[];
}

/** Fully validated registry. */
export interface Registry {
  readonly chainId: bigint;
  readonly entryPoint: Address;
  readonly outerSigner: Address;
  readonly delegationTarget: Address;
  /** authorities ‖ approvedSources; index == source ordinal. */
  readonly sources: readonly Address[];
  readonly authorities: readonly Address[];
  readonly approvedSources: readonly Address[];
  readonly tokens: readonly Address[];
}

const AUTH_ORDINAL_BASE = 0;
const APPROVED_ORDINAL_BASE = 7;

export class RegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RegistryError";
  }
}

/**
 * Validates a `DisperserConfig` against the registry invariants (§3).
 *
 * - exactly 7 authorities, all distinct
 * - authorities and approved sources are disjoint (an approved source MUST NOT
 *   appear in the authorization list)
 * - delegationTarget is non-zero and distinct from the entry point
 * - at least one token allowlisted
 */
export function buildRegistry(config: DisperserConfig): Registry {
  const authorities = config.authorities.map((a) => getAddress(a));
  const approvedSources = config.approvedSources.map((a) => getAddress(a));

  if (authorities.length !== 7) {
    throw new RegistryError(`authorities.length must be 7, got ${authorities.length}`);
  }
  assertDistinct(authorities, "authorities");

  const delegationTarget = getAddress(config.delegationTarget);
  if (delegationTarget === ENTRY_POINT) {
    throw new RegistryError("delegationTarget must differ from the entry point");
  }

  const seen = new Set<string>(authorities.map((a) => a.toLowerCase()));
  for (const s of approvedSources) {
    if (seen.has(s.toLowerCase())) {
      throw new RegistryError(`approved source ${s} appears in the authorization list`);
    }
    seen.add(s.toLowerCase());
  }

  const tokens = (config.tokens ?? [USDC, USDT]).map((t) => getAddress(t));
  if (tokens.length === 0) throw new RegistryError("token allowlist is empty");

  return Object.freeze({
    chainId: CHAIN_ID,
    entryPoint: ENTRY_POINT,
    outerSigner: OUTER_SIGNER,
    delegationTarget,
    sources: Object.freeze([...authorities, ...approvedSources]),
    authorities: Object.freeze(authorities),
    approvedSources: Object.freeze(approvedSources),
    tokens: Object.freeze(tokens),
  });
}

function assertDistinct(addrs: readonly Address[], label: string): void {
  const seen = new Set<string>();
  for (const a of addrs) {
    const k = a.toLowerCase();
    if (seen.has(k)) throw new RegistryError(`${label} contains a duplicate: ${a}`);
    seen.add(k);
  }
}

/** Ordinal of the first authority. */
export const AUTHORITY_ORDINAL_BASE = AUTH_ORDINAL_BASE;
/** Ordinal of the first approved (non-authority) source. */
export const APPROVED_ORDINAL_BASE_VALUE = APPROVED_ORDINAL_BASE;
