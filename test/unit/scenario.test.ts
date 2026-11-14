/**
 * Scenario config + key loading. These are the entry points the terminal harness uses,
 * so they are covered directly (parse validation, optional fields, signer alignment).
 */

import { describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { parseScenario, loadSigners, scenarioRecords } from "../../src/config/scenario.js";

const K = (i: number): `0x${string}` =>
  // Deterministic, valid secp256k1 keys for the test only.
  `0x${(i + 1).toString(16).padStart(2, "0").repeat(32)}`;

function baseScenario(overrides: Record<string, unknown> = {}): string {
  const authorities = [0, 1, 2, 3, 4, 5, 6].map((i) => privateKeyToAccount(K(i)).address);
  return JSON.stringify({
    name: "t",
    chainId: "31337",
    entryPoint: "0x0000000000000000000000000000000000000001",
    outerSigner: privateKeyToAccount(K(9)).address,
    delegationTarget: "0x0000000000000000000000000000000000000002",
    tokens: [
      "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      "0xdAC17F958D2ee523a2206206994597C13D831ec7",
    ],
    authorities,
    approvedSources: ["0x0000000000000000000000000000000000000003"],
    records: [
      {
        source: 0,
        token: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
        to: "0x0000000000000000000000000000000000009000",
        amount: "1000",
      },
    ],
    maxFeePerGas: "100000000000",
    maxPriorityFeePerGas: "1000000000",
    ...overrides,
  });
}

describe("parseScenario", () => {
  it("parses a valid scenario", () => {
    const s = parseScenario(baseScenario());
    expect(s.name).toBe("t");
    expect(s.chainId).toBe("31337");
    expect(s.authorities).toHaveLength(7);
    expect(s.records).toHaveLength(1);
    // Optional fields absent by default.
    expect(s.gasCap).toBeUndefined();
  });

  it("carries optional fields through when present", () => {
    const s = parseScenario(baseScenario({ gasCap: "900000", allowPartial: true, sweepMode: false }));
    expect(s.gasCap).toBe("900000");
    expect(s.allowPartial).toBe(true);
    expect(s.sweepMode).toBe(false);
  });

  it("rejects a missing required field", () => {
    const raw = JSON.parse(baseScenario());
    delete raw.chainId;
    expect(() => parseScenario(JSON.stringify(raw))).toThrow(/missing field: chainId/);
  });

  it("rejects the wrong authority count", () => {
    expect(() => parseScenario(baseScenario({ authorities: [] }))).toThrow(/must be 7/);
  });

  it("normalizes record addresses via checksum", () => {
    const s = parseScenario(baseScenario());
    const [r] = scenarioRecords(s);
    expect(r!.sourceOrdinal).toBe(0);
    expect(r!.amount).toBe(1000n);
    expect(r!.tag).toHaveLength(2 + 16); // 8 bytes hex
  });
});

describe("loadSigners", () => {
  const env = {
    OUTER_SIGNER_KEY: K(9),
    AUTHORITY_KEYS: [0, 1, 2, 3, 4, 5, 6].map(K).join(","),
  };

  it("aligns every authority key with the scenario", () => {
    const s = parseScenario(baseScenario());
    const bundle = loadSigners(s, env);
    expect(bundle.outer.address).toBe(s.outerSigner);
    for (const a of s.authorities) {
      expect(bundle.authorities[a.toLowerCase()]!.address).toBe(a);
    }
  });

  it("throws when the outer key does not match", () => {
    const s = parseScenario(baseScenario());
    expect(() => loadSigners(s, { ...env, OUTER_SIGNER_KEY: K(8) })).toThrow(
      /OUTER_SIGNER_KEY resolves to/,
    );
  });

  it("throws when the key count is wrong", () => {
    const s = parseScenario(baseScenario());
    expect(() => loadSigners(s, { ...env, AUTHORITY_KEYS: K(0) })).toThrow(/expected 7 authority keys/);
  });

  it("supports AUTHORITY_KEY_i fallback", () => {
    const s = parseScenario(baseScenario());
    const indexed: NodeJS.ProcessEnv = { OUTER_SIGNER_KEY: K(9) };
    [0, 1, 2, 3, 4, 5, 6].forEach((i) => (indexed[`AUTHORITY_KEY_${i}`] = K(i)));
    const bundle = loadSigners(s, indexed);
    expect(Object.keys(bundle.authorities)).toHaveLength(7);
  });
});
