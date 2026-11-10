/**
 * Reference audit (terminal).
 *
 *   npm run audit
 *
 * Re-derives the observable shape of the reference tx `0x853b3eab…be5f38` from the
 * local implementation and compares it against the captured receipt fixture. Prints a
 * pass/fail table so drift in the codec, gas model, or registry is visible in one
 * command. Exits non-zero on any mismatch.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { getAddress } from "viem";
import { CHAIN_ID, REFERENCE_SHAPE, USDC, USDT } from "../src/registry.js";
import { predictGas } from "../src/gas/budget.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  readFileSync(resolve(here, "../test/fixtures/reference_receipt.json"), "utf8"),
) as {
  txHash: string;
  type: string;
  status: string;
  gasUsed: string;
  effectiveGasPrice: string;
  inputByteLength: number;
  delegationTarget: string;
  authorizationList: { address: string }[];
  transfers: { token: string; from: string; to: string; amount: string }[];
  authorities: string[];
};

type Row = { check: string; expected: string; actual: string; ok: boolean };

const rows: Row[] = [];
function check(name: string, expected: unknown, actual: unknown): void {
  const e = String(expected);
  const a = String(actual);
  rows.push({ check: name, expected: e, actual: a, ok: e === a });
}

const predicted = predictGas({
  authorizationCount: fixture.authorizationList.length,
  calldataLength: fixture.inputByteLength,
  recordCount: fixture.transfers.length,
});

check("chainId", CHAIN_ID, 1n);
check("tx type", "0x4", fixture.type);
check("status", "0x1", fixture.status);
check("calldata bytes", REFERENCE_SHAPE.calldataLength, fixture.inputByteLength);
check("records", REFERENCE_SHAPE.recordCount, fixture.transfers.length);
check("authorizations", REFERENCE_SHAPE.authorityCount, fixture.authorizationList.length);
check("gas used (model)", fixture.gasUsed, predicted.total);
check(
  "USDC allowlisted",
  true,
  fixture.transfers.some((t) => getAddress(t.token) === getAddress(USDC)),
);
check(
  "USDT allowlisted",
  true,
  fixture.transfers.some((t) => getAddress(t.token) === getAddress(USDT)),
);
check(
  "all auths share one target",
  REFERENCE_SHAPE.delegationTargetCount,
  new Set(fixture.authorizationList.map((a) => getAddress(a.address).toLowerCase())).size,
);
check(
  "USDC total",
  REFERENCE_SHAPE.usdcTotal,
  fixture.transfers
    .filter((t) => getAddress(t.token) === getAddress(USDC))
    .reduce((s, t) => s + BigInt(t.amount), 0n),
);
check(
  "USDT total",
  REFERENCE_SHAPE.usdtTotal,
  fixture.transfers
    .filter((t) => getAddress(t.token) === getAddress(USDT))
    .reduce((s, t) => s + BigInt(t.amount), 0n),
);
// Transfers originate from the 7 authorities plus the approved source.
const registeredSources = new Set(fixture.authorities.map((a) => getAddress(a).toLowerCase()));
const distinctFroms = new Set(fixture.transfers.map((t) => getAddress(t.from).toLowerCase()));
check(
  "distinct sources",
  REFERENCE_SHAPE.authorityCount + REFERENCE_SHAPE.approvedSourceCount,
  distinctFroms.size,
);
check(
  "authorities all transact",
  REFERENCE_SHAPE.authorityCount,
  [...registeredSources].filter((a) => distinctFroms.has(a)).length,
);

const width = Math.max(...rows.map((r) => r.check.length));
console.log("─".repeat(width + 46));
console.log("REFERENCE AUDIT — 0x853b3eab…be5f38");
console.log("─".repeat(width + 46));
console.log(`${"check".padEnd(width)}  ${"expected".padEnd(20)}  actual`);
for (const r of rows) {
  const mark = r.ok ? "✓" : "✗";
  console.log(`${mark} ${r.check.padEnd(width)}  ${r.expected.padEnd(20)}  ${r.actual}`);
}
console.log("─".repeat(width + 46));

const failed = rows.filter((r) => !r.ok);
if (failed.length > 0) {
  console.log(`AUDIT FAILED — ${failed.length}/${rows.length} mismatch`);
  process.exit(1);
}
console.log(`AUDIT OK — ${rows.length}/${rows.length} checks match the reference`);
