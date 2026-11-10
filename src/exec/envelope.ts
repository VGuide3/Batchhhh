/**
 * Envelope assembler (§4, §5.5). Turns a `PlannedBatch` + auth tuples into the exact
 * type-4 transaction request: `to = entryPoint`, `data = packed 1156-byte payload`,
 * `authorizationList = [7 tuples]`, `type = 4`.
 *
 * The salt and batchId are derived here so the packed payload, the signature digest,
 * and the on-chain replay guard all agree.
 */

import type { Address, Hex } from "viem";
import { getAddress } from "viem";
import {
  encodeBatch,
  encodeTag,
  deriveBatchId,
  type PackedRecord,
} from "../codec/batch.js";
import type { AuthTuple, PlannedBatch } from "../plan/types.js";
import { DisperserError } from "../errors.js";

export interface Envelope {
  readonly to: Address;
  readonly type: "eip7702";
  readonly data: Hex;
  readonly authorizationList: readonly AuthTuple[];
  readonly salt: Hex;
  readonly batchId: Hex;
  readonly recordCount: number;
  readonly sourceCount: number;
  readonly byteLength: number;
}

export interface AssembleInput {
  readonly batch: PlannedBatch;
  readonly chainId: bigint;
  readonly entryPoint: Address;
  readonly authorizationList: readonly AuthTuple[];
}

/** Assembles the type-4 envelope for a planned batch. */
export function assembleEnvelope(input: AssembleInput): Envelope {
  const { batch, chainId, entryPoint } = input;

  const packedRecords: PackedRecord[] = batch.plan.records.map((r) => ({
    token: getAddress(r.token),
    to: getAddress(r.to),
    amount: r.amount,
    tag: r.tag,
  }));

  const batchId = deriveBatchId(chainId, entryPoint, batch.plan.salt);

  let flags = 0;
  if (batch.plan.allowPartial) flags |= 0x01;
  if (batch.plan.sweepMode) flags |= 0x02;

  const data = encodeBatch({
    flags,
    sourceCount: batch.sourceCount,
    batchId,
    records: packedRecords,
  });

  if (input.authorizationList.length === 0) {
    throw new DisperserError("envelope has no authorization tuples");
  }

  return {
    to: getAddress(entryPoint),
    type: "eip7702",
    data,
    authorizationList: input.authorizationList,
    salt: batch.plan.salt,
    batchId,
    recordCount: packedRecords.length,
    sourceCount: batch.sourceCount,
    byteLength: (data.length - 2) / 2,
  };
}

/**
 * Serializes records into the packed payload form for a given salt, without an auth
 * list. Useful for simulation and fixture generation.
 */
export function packRecords(
  records: readonly { token: Hex; to: Hex; amount: bigint; ordinal: number }[],
  sourceCount: number,
  salt: Hex,
  chainId: bigint,
  entryPoint: Address,
  flags = 0,
): Hex {
  const batchId = deriveBatchId(chainId, entryPoint, salt);
  return encodeBatch({
    flags,
    sourceCount,
    batchId,
    records: records.map((r) => ({
      token: getAddress(r.token),
      to: getAddress(r.to),
      amount: r.amount,
      tag: encodeTag(r.ordinal),
    })),
  });
}
