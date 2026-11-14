/**
 * Reference-batch fixture builder (§16). Produces a canonical 1156-byte payload for
 * a 14-record / 7-authority / 2-token batch. Deterministic addresses make the fixture
 * stable across runs and usable from both the TS and Foundry test suites.
 */

import { concatHex, getAddress, keccak256, toHex, type Address, type Hex } from "viem";
import { ENTRY_MAGIC, HEADER_SIZE, RECORD_SIZE, REFERENCE_LENGTH, encodeTag } from "../../src/codec/batch.js";
import { CHAIN_ID } from "../../src/registry.js";

/** The spec's reference shape (§0): 6 USDC + 8 USDT records over 7 authorities. */
export const REFERENCE_USDC_AMOUNT = 3940n; // 6 × 3940 = 23640
export const REFERENCE_USDT_AMOUNT = 2991n; // 8 × 2991 = 23928 — see note below

/**
 * NOTE: the spec's INV-6 asserts Σ USDT = 23934, but 8 × 2991 = 23928. The fixture
 * uses 2991 for the first seven USDT records and 2997 for the last (23928 − 2991 +
 * 2997 = 23934) so the totals match the spec exactly.
 */
export const REFERENCE_USDT_LAST_AMOUNT = 2997n;

export interface ReferenceFixture {
  readonly packed: Hex;
  readonly salt: Hex;
  readonly batchId: Hex;
  readonly authorities: readonly Address[];
  readonly recipients: readonly Address[];
  readonly usdc: Address;
  readonly usdt: Address;
}

export function referenceAuthorities(): Address[] {
  return Array.from({ length: 7 }, (_, i) => getAddress(toHex(BigInt(0x1000 + i + 1), { size: 20 })));
}

export function referenceRecipients(): Address[] {
  const out: Address[] = [];
  for (let i = 0; i < 6; i++) out.push(getAddress(toHex(BigInt(0x9000 + i), { size: 20 })));
  for (let i = 0; i < 8; i++) out.push(getAddress(toHex(BigInt(0xa000 + i), { size: 20 })));
  return out;
}

/**
 * Builds the reference fixture payload. `usdc`/`usdt` are injected so tests can point
 * at mock tokens while keeping the byte layout identical.
 */
export function buildReferenceFixture(args: {
  usdc: Address;
  usdt: Address;
  salt?: Hex;
  batchId: Hex;
}): ReferenceFixture {
  const salt = args.salt ?? keccak256(toHex("reference-plan"));
  const authorities = referenceAuthorities();
  const recipients = referenceRecipients();

  const parts: Hex[] = [
    ENTRY_MAGIC,
    "0x01", // version
    "0x00", // flags
    toHex(7, { size: 2 }), // sourceCount
    toHex(14, { size: 4 }), // recordCount
    args.batchId, // 24 bytes
  ];

  // 6 USDC records → authorities 0..5
  for (let i = 0; i < 6; i++) {
    parts.push(
      args.usdc,
      recipients[i]!,
      toHex(REFERENCE_USDC_AMOUNT, { size: 32 }),
      encodeTag(i),
    );
  }
  // 8 USDT records → authorities 0..6 (last one wraps back to 0)
  for (let i = 0; i < 8; i++) {
    const amount = i === 7 ? REFERENCE_USDT_LAST_AMOUNT : REFERENCE_USDT_AMOUNT;
    parts.push(args.usdt, recipients[6 + i]!, toHex(amount, { size: 32 }), encodeTag(i % 7));
  }

  const packed = concatHex(parts);
  const expected = HEADER_SIZE + RECORD_SIZE * 14;
  if ((packed.length - 2) / 2 !== expected || expected !== REFERENCE_LENGTH) {
    throw new Error(`fixture length ${(packed.length - 2) / 2} != ${REFERENCE_LENGTH}`);
  }
  return { packed, salt, batchId: args.batchId, authorities, recipients, usdc: args.usdc, usdt: args.usdt };
}

export { CHAIN_ID };
