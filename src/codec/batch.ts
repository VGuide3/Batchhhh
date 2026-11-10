/**
 * Packed batch codec for SPEC-7702-BATCH-001.
 *
 * Authoritative layout (see contracts/src/BatchDisperser.sol for the mirror):
 *
 *   offset  len  field
 *   0x000     4  selector 0xa9059cbb (entry magic)
 *   0x004     1  version = 0x01
 *   0x005     1  flags (bit0 allowPartial, bit1 sweepMode)
 *   0x006     2  sourceCount (u16 BE)
 *   0x008     4  recordCount (u32 BE)
 *   0x00C    24  batchId (bytes24)
 *   0x024  80*N  records: token[20] ‖ to[20] ‖ amount[32] ‖ tag[8]
 *
 * Total length = 36 + 80*recordCount. For 14 records that is exactly 1156 bytes.
 *
 * The source spec's offset table lists batchId as 20 bytes / records at 0x020
 * (yielding 1152) while simultaneously asserting `4 + 32 + 80*N` and requiring 1156
 * as an acceptance criterion. This codec implements the asserted formula, using a
 * 24-byte batchId, which reconciles the table with the acceptance criterion.
 */

import { bytesToHex, concatHex, hexToBytes, keccak256, toHex, type Hex } from "viem";
import {
  BadVersionError,
  CodecError,
  LengthMismatchError,
} from "../errors.js";

/** `transfer(address,uint256)` selector; doubles as the batch entry magic. */
export const ENTRY_MAGIC = "0xa9059cbb" as const;

/** Supported payload version. */
export const VERSION = 0x01;

export const FLAG_ALLOW_PARTIAL = 0x01;
export const FLAG_SWEEP_MODE = 0x02;

/** Fixed header size: selector(4) + version(1) + flags(1) + sourceCount(2) + recordCount(4) + batchId(24). */
export const HEADER_SIZE = 36;

/** Encoded size of one record. */
export const RECORD_SIZE = 80;

/** Per-source record ceiling (mirrors the contract constant). */
export const MAX_RECORDS_PER_SOURCE = 8;

/** Batch-wide record ceiling for v1. */
export const MAX_RECORDS = 64;

/** 14-record batch length: 36 + 14*80 = 1156. */
export const REFERENCE_LENGTH = HEADER_SIZE + RECORD_SIZE * 14;

export interface BatchHeader {
  readonly version: number;
  readonly flags: number;
  readonly sourceCount: number;
  readonly recordCount: number;
  readonly batchId: Hex; // 24 bytes
}

export interface PackedRecord {
  readonly token: Hex; // 20 bytes
  readonly to: Hex; // 20 bytes
  readonly amount: bigint; // 32 bytes
  readonly tag: Hex; // 8 bytes; tag[0:2] = source ordinal (u16 BE)
}

export interface DecodedBatch {
  readonly header: BatchHeader;
  readonly records: readonly PackedRecord[];
}

/** Derives the 24-byte batchId from (chainId, entryPoint, salt). */
export function deriveBatchId(chainId: bigint, entryPoint: Hex, salt: Hex): Hex {
  const hash = keccak256(
    concatHex([toHex(chainId, { size: 32 }), entryPoint, salt]),
  );
  // First 24 bytes of the keccak hash.
  return `0x${hash.slice(2, 2 + 48)}` as Hex;
}

/** Packs a source ordinal (u16 BE) and 6 reserved bytes into an 8-byte tag. */
export function encodeTag(ordinal: number): Hex {
  if (!Number.isInteger(ordinal) || ordinal < 0 || ordinal > 0xffff) {
    throw new CodecError(`ordinal out of u16 range: ${ordinal}`);
  }
  return `${toHex(ordinal, { size: 2 })}000000000000` as Hex;
}

/** Reads the source ordinal from a tag's first two bytes (u16 BE). */
export function decodeOrdinal(tag: Hex): number {
  const bytes = hexToBytes(tag);
  if (bytes.length !== 8) throw new CodecError(`tag must be 8 bytes, got ${bytes.length}`);
  return (bytes[0]! << 8) | bytes[1]!;
}

export interface EncodeInput {
  readonly version?: number;
  readonly flags?: number;
  readonly sourceCount: number;
  readonly batchId: Hex;
  readonly records: readonly PackedRecord[];
}

/**
 * Encodes a batch into the packed payload. Asserts the byte formula on the way out:
 * `result.length === HEADER_SIZE + RECORD_SIZE * records.length`.
 */
export function encodeBatch(input: EncodeInput): Hex {
  const { records } = input;
  const version = input.version ?? VERSION;
  const flags = input.flags ?? 0;

  if (records.length > MAX_RECORDS) {
    throw new CodecError(`recordCount ${records.length} exceeds MAX_RECORDS ${MAX_RECORDS}`);
  }
  if (input.batchId.length !== 2 + 48) {
    throw new CodecError(`batchId must be 24 bytes, got ${(input.batchId.length - 2) / 2}`);
  }
  if (input.sourceCount > 0xffff) {
    throw new CodecError(`sourceCount ${input.sourceCount} exceeds u16`);
  }

  const parts: Hex[] = [
    ENTRY_MAGIC,
    toHex(version, { size: 1 }),
    toHex(flags, { size: 1 }),
    toHex(input.sourceCount, { size: 2 }),
    toHex(records.length, { size: 4 }),
    input.batchId,
  ];

  for (const r of records) {
    assertBytes(r.token, 20, "record.token");
    assertBytes(r.to, 20, "record.to");
    assertBytes(r.tag, 8, "record.tag");
    if (r.amount < 0n || r.amount > (1n << 256n) - 1n) {
      throw new CodecError(`record.amount out of uint256 range: ${r.amount}`);
    }
    parts.push(r.token, r.to, toHex(r.amount, { size: 32 }), r.tag);
  }

  const packed = concatHex(parts);
  const expected = HEADER_SIZE + RECORD_SIZE * records.length;
  const actual = (packed.length - 2) / 2;
  if (actual !== expected) {
    throw new CodecError(`encoded length ${actual} !== expected ${expected}`);
  }
  return packed;
}

/**
 * Decodes and validates a packed payload. Enforces:
 *  - minimum header size
 *  - entry magic
 *  - version
 *  - `length === HEADER_SIZE + RECORD_SIZE * recordCount`
 */
export function decodeBatch(packed: Hex): DecodedBatch {
  const bytes = hexToBytes(packed);
  if (bytes.length < HEADER_SIZE) {
    throw new LengthMismatchError(
      `payload too short: ${bytes.length} < ${HEADER_SIZE}`,
    );
  }
  if (bytesToHex(bytes.slice(0, 4)) !== ENTRY_MAGIC) {
    throw new CodecError(
      `bad entry magic: ${bytesToHex(bytes.slice(0, 4))} != ${ENTRY_MAGIC}`,
    );
  }

  const version = bytes[4]!;
  if (version !== VERSION) throw new BadVersionError(version);

  const flags = bytes[5]!;
  const sourceCount = (bytes[6]! << 8) | bytes[7]!;
  const recordCount =
    ((bytes[8]! << 24) | (bytes[9]! << 16) | (bytes[10]! << 8) | bytes[11]!) >>> 0;
  const batchId = bytesToHex(bytes.slice(12, 36));

  const expected = HEADER_SIZE + RECORD_SIZE * recordCount;
  if (bytes.length !== expected) {
    throw new LengthMismatchError(
      `length mismatch: got ${bytes.length}, expected ${expected} (36 + 80*${recordCount})`,
    );
  }

  const records: PackedRecord[] = [];
  for (let i = 0; i < recordCount; i++) {
    const base = HEADER_SIZE + i * RECORD_SIZE;
    records.push({
      token: bytesToHex(bytes.slice(base, base + 20)),
      to: bytesToHex(bytes.slice(base + 20, base + 40)),
      amount: bytesToBigInt(bytes.slice(base + 40, base + 72)),
      tag: bytesToHex(bytes.slice(base + 72, base + 80)),
    });
  }

  return {
    header: { version, flags, sourceCount, recordCount, batchId },
    records,
  };
}

/** Returns the records attributed to `ordinal`, in original order. */
export function filterByOrdinal(
  records: readonly PackedRecord[],
  ordinal: number,
): PackedRecord[] {
  return records.filter((r) => decodeOrdinal(r.tag) === ordinal);
}

/** Groups records by source ordinal, preserving auth-list order. */
export function groupByOrdinal(
  records: readonly PackedRecord[],
  sourceCount: number,
): PackedRecord[][] {
  const groups: PackedRecord[][] = [];
  for (let s = 0; s < sourceCount; s++) groups.push(filterByOrdinal(records, s));
  return groups;
}

/** True if `length` is a valid packed payload length for some record count. */
export function isValidPackedLength(length: number): boolean {
  return length >= HEADER_SIZE && (length - HEADER_SIZE) % RECORD_SIZE === 0;
}

function assertBytes(hex: Hex, size: number, label: string): void {
  const actual = (hex.length - 2) / 2;
  if (hex.slice(0, 2) !== "0x" || actual !== size) {
    throw new CodecError(`${label} must be ${size} bytes, got ${actual}`);
  }
}

function bytesToBigInt(bytes: Uint8Array): bigint {
  let out = 0n;
  for (const b of bytes) out = (out << 8n) | BigInt(b);
  return out;
}
