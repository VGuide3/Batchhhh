/**
 * Public surface of the off-chain batch disperser library (SPEC-7702-BATCH-001).
 */

export * from "./errors.js";
export * from "./registry.js";

export {
  ENTRY_MAGIC,
  VERSION,
  FLAG_ALLOW_PARTIAL,
  FLAG_SWEEP_MODE,
  HEADER_SIZE,
  RECORD_SIZE,
  MAX_RECORDS_PER_SOURCE,
  REFERENCE_LENGTH,
  deriveBatchId,
  encodeTag,
  decodeOrdinal,
  encodeBatch,
  decodeBatch,
  filterByOrdinal,
  groupByOrdinal,
  isValidPackedLength,
  type BatchHeader,
  type PackedRecord,
  type DecodedBatch,
  type EncodeInput,
} from "./codec/batch.js";
export { MAX_RECORDS } from "./codec/batch.js";

export {
  asSourceOrdinal,
  DEFAULT_GAS_CAP,
  type SourceOrdinal,
  type TransferRecord,
  type SourceBalances,
  type TransferPlan,
  type AuthTuple,
  type PlannedBatch,
} from "./plan/types.js";
export * from "./plan/planner.js";
export * from "./plan/nonceAllocator.js";

export * from "./auth/signer.js";

export * from "./gas/budget.js";

export * from "./exec/envelope.js";
export * from "./exec/stateMachine.js";
export * from "./exec/broadcaster.js";
export * from "./exec/reconciler.js";
export * from "./exec/rollback.js";

export * from "./invariants/invariants.js";
export * from "./telemetry/telemetry.js";
