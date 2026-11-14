import { describe, expect, it } from "vitest";
import { getAddress, toHex, type Address } from "viem";
import { NonceAllocator, type NonceSource } from "../../src/plan/nonceAllocator.js";
import { NonceDriftError } from "../../src/errors.js";

const A: Address = getAddress(toHex(0x1, { size: 20 }));
const B: Address = getAddress(toHex(0x2, { size: 20 }));

function sourceWith(initial: Record<string, number>): NonceSource & { bump(a: Address): void } {
  const nonces = new Map(Object.entries(initial));
  return {
    async getTransactionCount(a: Address) {
      return nonces.get(a.toLowerCase()) ?? 0;
    },
    bump(a: Address) {
      nonces.set(a.toLowerCase(), (nonces.get(a.toLowerCase()) ?? 0) + 1);
    },
  };
}

describe("nonce allocator", () => {
  it("snapshots current nonces in order", async () => {
    const src = sourceWith({ [A.toLowerCase()]: 5, [B.toLowerCase()]: 9 });
    const alloc = new NonceAllocator(src);
    const snap = await alloc.snapshot([A, B]);
    expect(snap.entries).toEqual([
      { authority: A, nonce: 5n },
      { authority: B, nonce: 9n },
    ]);
  });

  it("passes the snapshot through withNonces when there is no drift", async () => {
    const src = sourceWith({ [A.toLowerCase()]: 5 });
    const alloc = new NonceAllocator(src);
    const snap = await alloc.snapshot([A]);
    const out = await alloc.withNonces([A], snap, (n) => n[0]!.nonce);
    expect(out).toBe(5n);
  });

  it("throws NonceDriftError when a nonce advances", async () => {
    const src = sourceWith({ [A.toLowerCase()]: 5 });
    const alloc = new NonceAllocator(src);
    const snap = await alloc.snapshot([A]);
    src.bump(A);
    await expect(alloc.withNonces([A], snap, () => 0)).rejects.toThrow(NonceDriftError);
  });

  it("serializes concurrent claims on the same authority", async () => {
    const src = sourceWith({ [A.toLowerCase()]: 1 });
    const alloc = new NonceAllocator(src);
    const snap = await alloc.snapshot([A]);
    const order: string[] = [];
    const p1 = alloc.withNonces([A], snap, async () => {
      order.push("p1-start");
      await new Promise((r) => setTimeout(r, 10));
      order.push("p1-end");
    });
    const p2 = alloc.withNonces([A], snap, () => {
      order.push("p2");
    });
    await Promise.all([p1, p2]);
    // p2 must not interleave inside p1's critical section.
    expect(order).toEqual(["p1-start", "p1-end", "p2"]);
  });
});
