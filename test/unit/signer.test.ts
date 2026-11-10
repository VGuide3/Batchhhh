import { describe, expect, it } from "vitest";
import { getAddress, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { signAuthorization, signAuthorizationList } from "../../src/auth/signer.js";

// Well-known test keys (never use on mainnet).
const KEYS = [
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
] as const;

const TARGET: Address = getAddress("0x00000000000000000000000000000000000000aa");

describe("auth signer", () => {
  it("signs a tuple with yParity ∈ {0,1} and low s", async () => {
    const signer = privateKeyToAccount(KEYS[0]);
    const tuple = await signAuthorization(signer, {
      chainId: 1n,
      delegationTarget: TARGET,
      nonce: 42n,
      authority: signer.address,
    });
    expect(tuple.yParity === 0 || tuple.yParity === 1).toBe(true);
    expect(tuple.address).toBe(getAddress(TARGET));
    expect(tuple.nonce).toBe(42n);
    expect((tuple.r.length - 2) / 2).toBe(32);
    expect((tuple.s.length - 2) / 2).toBe(32);
    const sBig = BigInt(tuple.s);
    expect(sBig).toBeLessThanOrEqual(
      0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n,
    );
  });

  it("rejects a signer that does not match the authority", async () => {
    const signer = privateKeyToAccount(KEYS[0]);
    await expect(
      signAuthorization(signer, {
        chainId: 1n,
        delegationTarget: TARGET,
        nonce: 0n,
        authority: getAddress("0x00000000000000000000000000000000000000bb"),
      }),
    ).rejects.toThrow();
  });

  it("signs a full list preserving order", async () => {
    const signers: Record<string, ReturnType<typeof privateKeyToAccount>> = {};
    const authorities: Address[] = [];
    for (const k of KEYS) {
      const acct = privateKeyToAccount(k);
      signers[acct.address.toLowerCase()] = acct;
      authorities.push(acct.address);
    }
    const nonces = [10n, 11n, 12n];
    const tuples = await signAuthorizationList(signers, authorities, nonces, TARGET, 1n);
    expect(tuples).toHaveLength(3);
    expect(tuples.map((t) => t.nonce)).toEqual([10n, 11n, 12n]);
    for (const t of tuples) expect(t.address).toBe(getAddress(TARGET));
  });

  it("produces distinct signatures for distinct nonces", async () => {
    const signer = privateKeyToAccount(KEYS[0]);
    const a = await signAuthorization(signer, {
      chainId: 1n,
      delegationTarget: TARGET,
      nonce: 1n,
      authority: signer.address,
    });
    const b = await signAuthorization(signer, {
      chainId: 1n,
      delegationTarget: TARGET,
      nonce: 2n,
      authority: signer.address,
    });
    expect(`${a.r}${a.s}`).not.toBe(`${b.r}${b.s}`);
  });
});
