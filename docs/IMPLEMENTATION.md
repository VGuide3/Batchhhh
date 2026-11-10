# Implementation notes

How the artifacts in this repo satisfy each section of the build spec in
`README.md` (`SPEC-7702-BATCH-001`). The spec is the contract; this file is the map.

## Reference ground truth

Every spec constant was re-verified against the real transaction on Ethereum
mainnet (block `0x192a394`). The captured receipt/transaction is
`test/fixtures/reference_receipt.json`; `test/unit/reference-audit.test.ts` asserts
the spec against it.

| Spec claim | Observed on-chain | Where asserted |
|---|---|---|
| type 4, status 1 | `0x4`, `0x1` | reference-audit |
| `gasUsed` 510676 | 510676 | reference-audit, `predictGas` |
| calldata 1156 bytes | 1156 | reference-audit, codec |
| 7 authorizations, 1 target | 7, all `0x2d36…3953` | reference-audit, INV-2/3/4 |
| 14 transfers, 2 tokens | 14, USDC+USDT | reference-audit, INV-5 |
| 8 senders, 14 recipients | 8, 14 | reference-audit, INV-5 |
| USDC Σ 23640, USDT Σ 23934 | matches | reference-audit, INV-6 |
| entry point is the 8th source | `0xebba…a5f6` in `from` set | reference-audit |

The spec's §17 open questions are now answered by the data:

1. The 8th source is the **entry point itself** (`0xebba…a5f6`), not the outer
   signer. It is modeled as an `approvedSource` (ordinal 7).
2. Recipients are 14 **distinct** addresses — consistent with fresh-EOA dispersion.
3. `allowPartial` stays declarative in v1 (no per-record try/catch).
4. A deadline is out of scope for v1.

## Section map

### §3 Address registry → `src/registry.ts`

`buildRegistry` validates: exactly 7 authorities, all distinct; authorities and
approved sources disjoint; delegation target ≠ entry point; non-empty allowlist.
All addresses are EIP-55 checksummed at load. `REFERENCE_AUTHORITIES`,
`REFERENCE_DELEGATION_TARGET`, `REFERENCE_BLOCK`, and `REFERENCE_SHAPE` pin the
observed values.

### §4–5 On-chain → `contracts/src/`

- `BatchDisperser.sol` — the single shared delegation implementation.
- `Registry.sol` — separate contract holding allowlists/identities (delegated code
  reads the delegating account's storage, so impl storage cannot be shared).
- `interfaces/IEIP7702BatchDisperser.sol` — errors, events, `Record`/`Header`.
- `libraries/SafeERC20.sol` — handles both return-data and USDT-style tokens.

**§5.2 mode discrimination**: `executeBatch` runs in the entry point's context and
`CALL`s each source; because the authority's code is `0xef0100‖impl`, that CALL
re-enters the implementation in the authority's own context. `executeLeaf` guards
with `isRegisteredSource(msg.sender)` (root = entry point) and reverts `NotRoot()`
otherwise.

**§5.3 root dispatch**: replay guard keyed on `batchId`, per-source filtering by
tag ordinal, error bubbling via assembly, relayer path with `keccak256(salt‖payload)`
signature recovery (low-`s`, `v ∈ {27,28}`).

**§5.5 byte layout**: `_decode` enforces `packed.length == 36 + 80*recordCount` and
the `0xa9059cbb` entry magic. `test/BatchDisperser.t.sol` fuzzes the length formula
and every off-by-one.

### §6 Off-chain data model → `src/plan/`, `src/codec/`

`TransferRecord`/`PlannedBatch` (`plan/types.ts`), planner gates
(`plan/planner.ts`), and the packed codec (`codec/batch.ts`). The codec is the
mirror of the Solidity decoder and is asserted byte-for-byte by the cross-language
test.

### §7 Execution state machine → `src/exec/stateMachine.ts`

`BatchStateMachine` enforces legal transitions
(`PLANNED → SIMULATED → AUTH_SIGNED → ASSEMBLED → BROADCAST → CONFIRMED`, plus
`FAILED`/`ROLLED_BACK`). Illegal transitions throw `DisperserError`.

### §8 Gas budget → `src/gas/budget.ts`

`predictGas` composes tx base (21000) + authorization intrinsic (12500 × 7) +
calldata intrinsic + execution residual, reproducing 510676 for the reference.
`enforceGasCeiling` applies the 1.15 simulation slack and the hard cap
(`DEFAULT_GAS_CAP = 600000`). `feeGuardOk` refuses when `baseFee × 1.125` exceeds
`maxFeePerGas`. `effectiveGasPrice` returns wei-per-gas; `weiToGwei` scales it.

### §9 Invariants → `src/invariants/invariants.ts`

`inv1`..`inv11` each return `{ id, ok, detail }`; `checkAll` runs them in order.
They are exercised three ways: synthetic (`test/unit/invariants.test.ts`), against
the real receipt (`test/unit/reference-audit.test.ts`), and in the demo
(`scripts/demo.ts`).

### §10–11 Failure modes & security → typed errors + contract posture

`src/errors.ts` mirrors every on-chain custom error. The implementation has no
owner, no proxy, no `delegatecall`, no `approve`, no arbitrary sweep. The token
allowlist blocks fee/rebasing tokens that would break INV-9.

### §12 Test plan

- Foundry unit (`contracts/test/BatchDisperser.t.sol`): decode, mode, version,
  replay, allowlist, fuzz.
- Cross-language (`contracts/test/CrossLanguage.t.sol`): the TS-produced 1156-byte
  fixture executes on-chain to 14 transfers / correct totals / replay rejection.
- Fork (`contracts/test/Fork.t.sol`): gated on `ETH_RPC_URL`; asserts the reference
  is a successful type-4 tx.
- Vitest (`test/unit/`): codec, planner, signer, gas, invariants, exec, nonce
  allocator, reference audit.

### §13 Deployment → `contracts/script/Deploy.s.sol`

Predicts the impl address from the deployer nonce (the Registry stores it as
`delegationTarget`), deploys both, and prints the addresses to record.

### §14 Telemetry → `src/telemetry/telemetry.ts`

`TelemetryRecord` captures all spec fields; `evaluateAlerts` fires on invariant
failure, `gasUsed > 0.9 × gasCap`, authority mismatch, and record-count mismatch.

### §15 Acceptance criteria

| Criterion | Status | Evidence |
|---|---|---|
| Replay reproduces 14 transfers / 2 tokens / 8 sources / 14 recipients | Met | reference-audit, demo |
| `gasUsed` within 5% of 510676 | Met (exact) | `predictGas` = 510676 |
| All 11 invariants green | Met | `checkAll` on real receipt |
| Byte assertion `36 + 80*N` enforced + tested | Met | `_decode`, codec tests |
| 7 authorities → 1 shared target; INV-8 | Met | reference-audit, fork |
| No delegatecall/approve/owner | Met | contract source |
| `MAX_RECORDS_PER_SOURCE = 8`, `gasCap = 600000` | Met | contract + budget |

### §16 Replay harness → `scripts/`

`scripts/emit-fixture.ts` regenerates the cross-language fixture; `scripts/demo.ts`
runs the whole off-chain pipeline and prints every invariant result. The spec's
`cast run` command is still valid for trace-level inspection.

## What is modeled vs. reproduced

The reference transaction cannot be **replayed** byte-for-byte because that needs
the 7 authority private keys (and the outer signer's). What this repo does instead:

1. Re-derives the reference's observable shape from the real receipt and asserts
   the spec against it (`reference-audit`).
2. Executes a TS-encoded batch of the same shape through the Solidity
   implementation on a local EVM and asserts the same outcome
   (`CrossLanguage.t.sol`).
3. Provides a gated mainnet fork test for the reference receipt.

Together these prove the off-chain encoder, the on-chain decoder/executor, and the
spec all agree, without needing live authority keys.
