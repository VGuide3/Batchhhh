/**
 * Authorization-tuple signer (§5, §7).
 *
 * EIP-7702 authorizations are signed over
 *   keccak256(0x05 ‖ rlp([chain_id, address, nonce]))
 * where `address` is the delegation target and `nonce` is the authority's CURRENT
 * (pre-increment) account nonce. One tuple per authority; all 7 share the target.
 *
 * Tuple malleability is rejected up front: `yParity ∈ {0,1}` and low-`s` is enforced.
 */

import { hashAuthorization } from "viem/experimental";
import { getAddress, hexToBytes, type Hex, type Address } from "viem";
import { DisperserError } from "../errors.js";
import type { AuthTuple } from "../plan/types.js";

/** secp256k1 group order / 2 — the low-`s` ceiling (EIP-2). */
const SECP256K1N_HALF =
  0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n;

/** Minimal signer surface; satisfied by viem `privateKeyToAccount`. */
export interface HashSigner {
  sign(args: { hash: Hex }): Promise<Hex>;
  readonly address: Address;
}

export interface SignAuthParams {
  readonly chainId: bigint;
  readonly delegationTarget: Address;
  readonly nonce: bigint;
  readonly authority: Address;
}

/** Computes the EIP-7702 authorization digest for a tuple. */
export function authorizationDigest(params: SignAuthParams): Hex {
  return hashAuthorization({
    chainId: Number(params.chainId),
    address: params.delegationTarget,
    nonce: Number(params.nonce),
  });
}

/** Signs a single authorization tuple with the authority's key. */
export async function signAuthorization(
  signer: HashSigner,
  params: SignAuthParams,
): Promise<AuthTuple> {
  if (params.authority.toLowerCase() !== signer.address.toLowerCase()) {
    throw new DisperserError(
      `signer ${signer.address} does not match authority ${params.authority}`,
    );
  }
  const digest = authorizationDigest(params);
  const sig = hexToBytes(await signer.sign({ hash: digest }));
  if (sig.length !== 65) {
    throw new DisperserError(`expected 65-byte signature, got ${sig.length}`);
  }

  const r = bytesToHex(sig.slice(0, 32));
  const s = bytesToHex(sig.slice(32, 64));
  let v = sig[64]!;
  // Normalize yParity; viem returns yParity (0/1) for `sign`.
  if (v === 27 || v === 28) v -= 27;

  const sBig = BigInt(s);
  if (sBig > SECP256K1N_HALF) {
    throw new DisperserError("signature has high s (malleable)");
  }
  if (v !== 0 && v !== 1) {
    throw new DisperserError(`invalid yParity: ${v}`);
  }

  return {
    chainId: params.chainId,
    address: getAddress(params.delegationTarget),
    nonce: params.nonce,
    yParity: v as 0 | 1,
    r,
    s,
  };
}

/**
 * Signs the full auth list for a set of authorities, preserving order and pairing
 * each with its nonce. `signers` MUST be keyed by lowercase authority address.
 */
export async function signAuthorizationList(
  signers: Readonly<Record<string, HashSigner>>,
  authorities: readonly Address[],
  nonces: readonly bigint[],
  delegationTarget: Address,
  chainId: bigint,
): Promise<readonly AuthTuple[]> {
  if (authorities.length !== nonces.length) {
    throw new DisperserError("authorities/nonces length mismatch");
  }
  const tuples: AuthTuple[] = [];
  for (let i = 0; i < authorities.length; i++) {
    const authority = authorities[i]!;
    const signer = signers[authority.toLowerCase()];
    if (!signer) throw new DisperserError(`no signer for authority ${authority}`);
    tuples.push(
      await signAuthorization(signer, {
        chainId,
        delegationTarget,
        nonce: nonces[i]!,
        authority,
      }),
    );
  }
  return tuples;
}

function bytesToHex(bytes: Uint8Array): Hex {
  let out = "0x";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out as Hex;
}
