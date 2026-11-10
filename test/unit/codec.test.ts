import { describe, expect, it } from "vitest";
import { getAddress, keccak256, toHex } from "viem";
import {
  HEADER_SIZE,
  RECORD_SIZE,
  REFERENCE_LENGTH,
  decodeBatch,
  decodeOrdinal,
  deriveBatchId,
  encodeBatch,
  encodeTag,
  filterByOrdinal,
  groupByOrdinal,
  isValidPackedLength,
} from "../../src/codec/batch.js";
import { BadVersionError, CodecError, LengthMismatchError } from "../../src/errors.js";
import { buildReferenceFixture } from "../fixtures/reference.js";

const USDC = getAddress("0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48");
const USDT = getAddress("0xdAC17F958D2ee523a2206206994597C13D831ec7");
const BATCH_ID = keccak256(toHex("batch")).slice(0, 2 + 48) as `0x${string}`;

function fixture() {
  return buildReferenceFixture({ usdc: USDC, usdt: USDT, batchId: BATCH_ID });
}

describe("codec: byte layout", () => {
  it("encodes a 14-record batch to exactly 1156 bytes", () => {
    const { packed } = fixture();
    expect((packed.length - 2) / 2).toBe(1156);
    expect(REFERENCE_LENGTH).toBe(1156);
    expect(HEADER_SIZE).toBe(36);
    expect(RECORD_SIZE).toBe(80);
  });

  it("enforces the 36 + 80*N formula for all N in 1..64", () => {
    for (let n = 1; n <= 64; n++) {
      const records = Array.from({ length: n }, (_, i) => ({
        token: USDC,
        to: getAddress(toHex(BigInt(0x100 + i), { size: 20 })),
        amount: 1n,
        tag: encodeTag(0),
      }));
      const packed = encodeBatch({ sourceCount: 1, batchId: BATCH_ID, records });
      expect((packed.length - 2) / 2).toBe(36 + 80 * n);
      expect(isValidPackedLength((packed.length - 2) / 2)).toBe(true);
    }
  });

  it("round-trips header and records", () => {
    const { packed } = fixture();
    const decoded = decodeBatch(packed);
    expect(decoded.header.version).toBe(1);
    expect(decoded.header.sourceCount).toBe(7);
    expect(decoded.header.recordCount).toBe(14);
    expect(decoded.header.batchId).toBe(BATCH_ID);
    expect(decoded.records).toHaveLength(14);
  });

  it("rejects an off-by-one length", () => {
    const { packed } = fixture();
    const truncated = packed.slice(0, packed.length - 2) as `0x${string}`;
    expect(() => decodeBatch(truncated)).toThrow(LengthMismatchError);
  });

  it("rejects a wrong version byte", () => {
    const { packed } = fixture();
    // version is at byte 4 → hex chars 2 + 8 = 10..12
    const bad = `${packed.slice(0, 10)}02${packed.slice(12)}` as `0x${string}`;
    expect(() => decodeBatch(bad)).toThrow(BadVersionError);
  });

  it("rejects a bad entry magic", () => {
    const { packed } = fixture();
    const bad = `0xdeadbeef${packed.slice(10)}` as `0x${string}`;
    expect(() => decodeBatch(bad)).toThrow(CodecError);
  });

  it("rejects a payload shorter than the header", () => {
    expect(() => decodeBatch("0xa9059cbb01" as `0x${string}`)).toThrow(LengthMismatchError);
  });
});

describe("codec: tags and grouping", () => {
  it("encodes and decodes source ordinals as u16 BE", () => {
    for (const ordinal of [0, 1, 6, 7, 255, 256, 65535]) {
      const tag = encodeTag(ordinal);
      expect((tag.length - 2) / 2).toBe(8);
      expect(decodeOrdinal(tag)).toBe(ordinal);
    }
  });

  it("rejects out-of-range ordinals", () => {
    expect(() => encodeTag(-1)).toThrow(CodecError);
    expect(() => encodeTag(65536)).toThrow(CodecError);
  });

  it("groups records by ordinal in order", () => {
    const { packed } = fixture();
    const { records } = decodeBatch(packed);
    const groups = groupByOrdinal(records, 7);
    expect(groups).toHaveLength(7);
    expect(groups.flat()).toHaveLength(14);
    // authority 0 gets 1 USDC + 2 USDT (records with tag 0).
    expect(filterByOrdinal(records, 0)).toHaveLength(3);
  });
});

describe("codec: batchId derivation", () => {
  it("is deterministic in (chainId, entryPoint, salt)", () => {
    const salt = keccak256(toHex("salt"));
    const a = deriveBatchId(1n, "0xebbabfc2019a312e3615196e9ac517c6bee2a5f6", salt);
    const b = deriveBatchId(1n, "0xebbabfc2019a312e3615196e9ac517c6bee2a5f6", salt);
    expect(a).toBe(b);
    expect((a.length - 2) / 2).toBe(24);
  });

  it("changes with chainId", () => {
    const salt = keccak256(toHex("salt"));
    const a = deriveBatchId(1n, "0xebbabfc2019a312e3615196e9ac517c6bee2a5f6", salt);
    const b = deriveBatchId(2n, "0xebbabfc2019a312e3615196e9ac517c6bee2a5f6", salt);
    expect(a).not.toBe(b);
  });
});
