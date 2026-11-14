# AGENTS.md

Repository memory for `EIP7702-BATCH-DISPERSER/v1`. Read this before changing code.

## What this is

A reproducible, auditable implementation of the system described in `README.md`
(the build spec, `SPEC-7702-BATCH-001`). It generalizes the on-chain reference
transaction `0x853b3eab…be5f38`: one EIP-7702 shared delegation target, 7 authority
EOAs, 14 ERC-20 transfers, Ethereum mainnet.

Three deliverables in one repo:

- `contracts/` — Solidity (Foundry). The on-chain `BatchDisperser` + `Registry`.
- `src/` — TypeScript off-chain library (planner, signer, broadcaster, reconciler,
  invariants, telemetry) plus a `chain/` I/O port and a `run/` orchestrator.
- `scripts/` + `test/` — reproducible fixtures, a full dry-run demo, a terminal
  CLI (bootstrap / sponsor / run / audit / e2e), and tests.

## Ground truth (verified on-chain)

Read `src/registry.ts` — it pins values read directly from the reference tx
(`test/fixtures/reference_receipt.json`), not guesses:

- `ENTRY_POINT` = `0xebba…a5f6` (`tx.to`, also the 8th dispersal source).
- `OUTER_SIGNER` = `0x693b…3be2` (pays gas, no delegation).
- `REFERENCE_DELEGATION_TARGET` = `0x2d36fa3b1279eecaa198bacbd578bb4dbe139953`.
- `REFERENCE_AUTHORITIES` — the 7 EOAs recovered from the authorization list.
- Reference shape: `gasUsed 510676`, `calldata 1156 bytes`, 14 transfers,
  2 tokens, 8 senders, 14 recipients, USDC Σ 23640, USDT Σ 23934.

The `authorization_list` RPC `address` field is the **delegation target**, not the
authority. Recover the authority from `r/s/yParity` (`recoverAuthorizationAddress`
from `viem/experimental`).

## Commands

```bash
npm run typecheck     # tsc --noEmit
npm test              # vitest (93 tests)
npm run demo          # full off-chain pipeline dry run, all INV-1..INV-11
npm run audit         # re-derive the reference tx shape and diff it (14 checks)
npm run fixture       # regenerate contracts/test/fixtures/reference_batch.json
npm run forge:test    # Foundry (25 tests; fork test skipped without ETH_RPC_URL)
npm run verify        # typecheck + vitest + fixture + forge

# terminal CLI (local anvil)
npm run anvil         # anvil --hardfork prague (:8545)
npm run anvil:bootstrap   # deploy + delegate + fund; writes scenarios/anvil.{json,env}
npm run sponsor       # inspect: per-source outflow, live balances, gas, sponsor ETH
npm run run:dry       # plan + sign + simulate, stop before broadcast
npm run run           # broadcast + reconcile (all 11 invariants)
npm run e2e           # one command: anvil + bootstrap + sponsor + run + teardown
```

Foundry needs `~/.foundry/bin` on `PATH`. `forge test` is hermetic; the fork test
in `contracts/test/Fork.t.sol` runs only when `ETH_RPC_URL` is set. **Unset
`ETH_RPC_URL` before `forge test`** if you exported it for a local run — the fork test
will otherwise try to read the reference tx from your anvil and fail.

## Automated pipeline

`src/run/runner.ts` (`runBatch`) drives the whole flow: preflight → plan → nonce
snapshot + sign authorizations → assemble envelope → simulate → guards → broadcast →
confirm → reconcile → telemetry. It talks to the node only through `ChainPort`
(`src/chain/port.ts`); `ViemChainPort` (`src/chain/viemPort.ts`) is the real adapter
and `test/unit/runner.test.ts` uses an in-memory fake. A **scenario**
(`src/config/scenario.ts`, `scenarios/anvil.json`) describes the on-chain wiring,
authorities, records, and fee policy; keys load from `OUTER_SIGNER_KEY` +
`AUTHORITY_KEYS` (or `AUTHORITY_KEY_i`).

The entry point is called in **root mode via `fallback()`**: the packed payload's
first 4 bytes are the `0xa9059cbb` magic, which is not a named selector, so the raw
calldata *is* the batch. This is why the reference calldata is exactly 1156 bytes
with no ABI wrapper. `executeBatch(bytes32,bytes)` remains the ABI/relayer path. The
fallback is outer-signer-only (there is no salt to bind a relayer signature to).

## Layout conventions

- ESM + `verbatimModuleSyntax`; **relative imports must end in `.js`** (TS source,
  emitted JS target). Missing `.js` breaks `tsx`/`vitest`.
- `tsconfig` has `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`; index
  accesses are `T | undefined`, so guard or assert (`arr[i]!`).
- Types live in `src/plan/types.ts` (`TransferRecord`, `SourceOrdinal`,
  `PlannedBatch`). The on-chain `Record` struct mirrors it but is named separately —
  do not re-export both from a barrel without aliasing.
- Errors: every on-chain custom error has a counterpart in `src/errors.ts`. Never
  string-match error text; use the typed classes.

## Critical invariants

- Packed layout total is `36 + 80*N`. For 14 records that is **exactly 1156**.
  Header: `magic[4] version[1] flags[1] sourceCount[2] recordCount[4] batchId[24]`.
- `MAX_RECORDS_PER_SOURCE = 8`, default `gasCap = 600000`.
- Root mode runs in the entry point's context; leaf mode runs in each authority's
  context. `executeLeaf` only accepts `msg.sender` that is a registered source.
- The registry is a **separate contract**: delegated code reads the delegating
  account's storage, so impl constructor state is not visible in leaf mode.
- Cross-language coupling: `scripts/emit-fixture.ts` (TS) writes the fixture that
  `contracts/test/CrossLanguage.t.sol` (Solidity) decodes and executes. If you
  change the codec, regenerate the fixture and re-run both suites.

## Gotchas

- `MockERC20` emits `Transfer`; the cross-language test counts them (INV-5).
- `contracts/test/fixtures/reference_batch.json` is generated — do not hand-edit.
- `test/fixtures/reference_receipt.json` is captured mainnet data — do not hand-edit.
- Never commit real keys. `scripts/demo.ts` uses well-known Anvil/test keys only.
