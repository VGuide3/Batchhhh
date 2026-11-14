/**
 * Typed error hierarchy for the batch disperser. Every on-chain custom error in
 * IEIP7702BatchDisperser has a counterpart here so the off-chain state machine and
 * reconciler can classify failures without string matching.
 */

export class DisperserError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** Plan or registry input failed a validation gate. */
export class PlanError extends DisperserError {}

/** Packed payload violated the byte layout / length assertion. */
export class CodecError extends DisperserError {}

/** A batchId was submitted twice. Mirrors on-chain `BatchIdReplay(bytes24)`. */
export class BatchIdReplayError extends DisperserError {
  constructor(public readonly batchId: `0x${string}`) {
    super(`batchId already executed: ${batchId}`);
  }
}

/** Caller was neither the outer signer nor a valid relayer. Mirrors `NotRoot()`. */
export class NotRootError extends DisperserError {}

/** Packed payload version byte is unsupported. Mirrors `BadVersion()`. */
export class BadVersionError extends DisperserError {
  constructor(public readonly version: number) {
    super(`unsupported payload version: 0x${version.toString(16).padStart(2, "0")}`);
  }
}

/** `packed.length !== 36 + 80 * recordCount`. Mirrors `LengthMismatch()`. */
export class LengthMismatchError extends DisperserError {}

/** A source ordinal is not registered. Mirrors `UnknownSource(uint16)`. */
export class UnknownSourceError extends DisperserError {
  constructor(public readonly ordinal: number) {
    super(`unknown source ordinal: ${ordinal}`);
  }
}

/** A source has no EIP-7702 delegation designator. Mirrors `SourceNotDelegated`. */
export class SourceNotDelegatedError extends DisperserError {
  constructor(public readonly source: `0x${string}`) {
    super(`source not delegated: ${source}`);
  }
}

/** A token is not allowlisted or the transfer failed. Mirrors `TransferFailed`. */
export class TransferFailedError extends DisperserError {}

/** A source slice exceeded MAX_RECORDS_PER_SOURCE. Mirrors `RecordCapExceeded()`. */
export class RecordCapExceededError extends DisperserError {}

/** Authority nonce changed between snapshot and signing/broadcast. */
export class NonceDriftError extends DisperserError {
  constructor(
    public readonly authority: `0x${string}`,
    public readonly expected: bigint,
    public readonly actual: bigint,
  ) {
    super(`nonce drift for ${authority}: expected ${expected}, got ${actual}`);
  }
}

/** Broadcaster fee guard refused the tx. */
export class FeeGuardError extends DisperserError {}

/** Simulation exceeded the gas ceiling. */
export class GasCeilingError extends DisperserError {}

/** A post-confirmation invariant failed. */
export class InvariantError extends DisperserError {
  constructor(
    public readonly id: string,
    message: string,
  ) {
    super(`[${id}] ${message}`);
  }
}
