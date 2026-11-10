/**
 * Nonce allocator (§7). Assigns each authority the next EIP-7702 authorization nonce,
 * which is the authority's CURRENT account nonce (pre-increment) at signing time.
 *
 * Concurrency safety: the allocator serializes access per authority with an in-memory
 * mutex so two concurrent batches cannot claim the same nonce.
 */

import type { Address } from "viem";
import { NonceDriftError } from "../errors.js";

export interface AuthorityNonce {
  readonly authority: Address;
  readonly nonce: bigint;
}

export interface NonceSource {
  /** Reads the current account nonce from the node. */
  getTransactionCount(authority: Address, blockTag?: bigint | "latest" | "pending"): Promise<number>;
}

export interface NonceSnapshot {
  readonly at: "latest" | "pending";
  readonly entries: readonly AuthorityNonce[];
}

export class NonceAllocator {
  private readonly locks = new Map<string, Promise<void>>();

  constructor(private readonly source: NonceSource) {}

  /**
   * Reads a snapshot of current nonces for every authority. `authorities` order is
   * preserved so it can be aligned with the auth list.
   */
  async snapshot(
    authorities: readonly Address[],
    blockTag: bigint | "latest" | "pending" = "latest",
  ): Promise<NonceSnapshot> {
    const entries: AuthorityNonce[] = [];
    for (const authority of authorities) {
      const nonce = BigInt(await this.source.getTransactionCount(authority, blockTag));
      entries.push({ authority, nonce });
    }
    return { at: blockTag === "pending" ? "pending" : "latest", entries };
  }

  /**
   * Runs `fn` under a per-authority lock, then verifies the nonces have not drifted
   * from the snapshot. Returns whatever `fn` returns.
   */
  async withNonces<T>(
    authorities: readonly Address[],
    snapshot: NonceSnapshot,
    fn: (nonces: readonly AuthorityNonce[]) => Promise<T> | T,
  ): Promise<T> {
    const keys = authorities.map((a) => a.toLowerCase()).sort();
    return this.withLocks(keys, async () => {
      await this.assertNoDrift(authorities, snapshot);
      return fn(snapshot.entries);
    });
  }

  /** Re-reads nonces and throws on the first drift. */
  async assertNoDrift(
    authorities: readonly Address[],
    snapshot: NonceSnapshot,
  ): Promise<void> {
    for (const authority of authorities) {
      const expected = snapshot.entries.find(
        (e) => e.authority.toLowerCase() === authority.toLowerCase(),
      );
      if (!expected) continue;
      const actual = BigInt(await this.source.getTransactionCount(authority, "latest"));
      if (actual !== expected.nonce) {
        throw new NonceDriftError(authority, expected.nonce, actual);
      }
    }
  }

  private async withLocks<T>(keys: readonly string[], fn: () => Promise<T>): Promise<T> {
    const releases: Array<() => void> = [];
    for (const key of keys) {
      const prev = this.locks.get(key) ?? Promise.resolve();
      let release!: () => void;
      const next = new Promise<void>((resolve) => {
        release = resolve;
      });
      this.locks.set(
        key,
        prev.then(() => next),
      );
      await prev;
      releases.push(() => {
        release();
        if (this.locks.get(key) === prev.then(() => next)) this.locks.delete(key);
      });
    }
    try {
      return await fn();
    } finally {
      for (const r of releases) r();
    }
  }
}
