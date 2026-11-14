/**
 * Scenario configuration (§6). A scenario is a self-contained, reproducible batch:
 * the on-chain wiring (entry point, delegation target, tokens), the authority set,
 * the transfers, and the fee policy. Loading it from JSON keeps runs auditable and
 * lets the terminal harness, tests, and the demo share one description.
 */

import { getAddress, type Address, type Hex } from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { readFileSync } from "node:fs";
import { asSourceOrdinal, type SourceOrdinal, type TransferRecord } from "../plan/types.js";
import { encodeTag } from "../codec/batch.js";
import { DisperserError } from "../errors.js";

export interface ScenarioRecord {
  readonly source: number;
  readonly token: Address;
  readonly to: Address;
  /** Base units, as a decimal string. */
  readonly amount: string;
}

export interface Scenario {
  readonly name: string;
  readonly chainId: string;
  readonly entryPoint: Address;
  readonly outerSigner: Address;
  readonly delegationTarget: Address;
  readonly tokens: readonly Address[];
  readonly authorities: readonly Address[];
  readonly approvedSources: readonly Address[];
  readonly records: readonly ScenarioRecord[];
  readonly maxFeePerGas: string;
  readonly maxPriorityFeePerGas: string;
  readonly gasCap?: string;
  readonly allowPartial?: boolean;
  readonly sweepMode?: boolean;
}

const A = (s: string): Address => getAddress(s);

/** Parses and validates a scenario JSON string. */
export function parseScenario(json: string): Scenario {
  const raw = JSON.parse(json) as Partial<Scenario>;
  const need = <K extends keyof Scenario>(k: K): NonNullable<Scenario[K]> => {
    const v = raw[k];
    if (v === undefined || v === null) throw new DisperserError(`scenario missing field: ${k}`);
    return v as NonNullable<Scenario[K]>;
  };

  const authorities = (need("authorities") as string[]).map(A);
  if (authorities.length !== 7) {
    throw new DisperserError(`scenario.authorities must be 7, got ${authorities.length}`);
  }

  const base: Scenario = {
    name: need("name"),
    chainId: need("chainId"),
    entryPoint: A(need("entryPoint") as string),
    outerSigner: A(need("outerSigner") as string),
    delegationTarget: A(need("delegationTarget") as string),
    tokens: (need("tokens") as string[]).map(A),
    authorities,
    approvedSources: ((raw.approvedSources ?? []) as string[]).map(A),
    records: (need("records") as ScenarioRecord[]).map((r) => ({
      source: r.source,
      token: A(r.token),
      to: A(r.to),
      amount: r.amount,
    })),
    maxFeePerGas: need("maxFeePerGas"),
    maxPriorityFeePerGas: need("maxPriorityFeePerGas"),
  };
  return {
    ...base,
    ...(raw.gasCap !== undefined ? { gasCap: raw.gasCap } : {}),
    ...(raw.allowPartial !== undefined ? { allowPartial: raw.allowPartial } : {}),
    ...(raw.sweepMode !== undefined ? { sweepMode: raw.sweepMode } : {}),
  };
}

export function loadScenario(path: string): Scenario {
  return parseScenario(readFileSync(path, "utf8"));
}

/** Converts scenario records into the planner's `TransferRecord[]`. */
export function scenarioRecords(s: Scenario): TransferRecord[] {
  return s.records.map((r) => ({
    sourceOrdinal: asSourceOrdinal(r.source) as SourceOrdinal,
    token: r.token,
    to: r.to,
    amount: BigInt(r.amount),
    tag: encodeTag(r.source),
  }));
}

export interface SignerBundle {
  /** Lowercase authority → signer account. */
  readonly authorities: Record<string, PrivateKeyAccount>;
  readonly outer: PrivateKeyAccount;
}

/**
 * Loads the outer signer and every authority key from the environment.
 * Authority keys are read from `AUTHORITY_KEYS` (comma-separated) or `AUTHORITY_KEY_i`.
 * The outer signer is `OUTER_SIGNER_KEY`.
 */
export function loadSigners(s: Scenario, env: NodeJS.ProcessEnv = process.env): SignerBundle {
  const outerKey = env.OUTER_SIGNER_KEY;
  if (!outerKey) throw new DisperserError("OUTER_SIGNER_KEY is not set");

  const keys: string[] = [];
  if (env.AUTHORITY_KEYS) {
    keys.push(...env.AUTHORITY_KEYS.split(",").map((k) => k.trim()).filter(Boolean));
  } else {
    for (let i = 0; i < s.authorities.length; i++) {
      const k = env[`AUTHORITY_KEY_${i}`];
      if (!k) throw new DisperserError(`AUTHORITY_KEY_${i} is not set (or set AUTHORITY_KEYS)`);
      keys.push(k.trim());
    }
  }
  if (keys.length !== s.authorities.length) {
    throw new DisperserError(
      `expected ${s.authorities.length} authority keys, got ${keys.length}`,
    );
  }

  const accounts = keys.map((k) => privateKeyToAccount(k as Hex));
  const byAddr = new Map(accounts.map((a) => [a.address.toLowerCase(), a]));

  const authorities: Record<string, PrivateKeyAccount> = {};
  for (const expected of s.authorities) {
    const acct = byAddr.get(expected.toLowerCase());
    if (!acct) {
      throw new DisperserError(`no loaded key matches authority ${expected}`);
    }
    authorities[expected.toLowerCase()] = acct;
  }

  const outer = privateKeyToAccount(outerKey as Hex);
  if (outer.address.toLowerCase() !== s.outerSigner.toLowerCase()) {
    throw new DisperserError(
      `OUTER_SIGNER_KEY resolves to ${outer.address}, scenario expects ${s.outerSigner}`,
    );
  }

  return { authorities, outer };
}
