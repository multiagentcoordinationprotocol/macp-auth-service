import * as jose from 'jose';
import type { SigningAlg } from './config';

export interface SigningMaterial {
  privateKey: jose.KeyLike | Uint8Array;
  jwks: { keys: jose.JWK[] };
  alg: SigningAlg;
  source: 'ephemeral' | 'env';
}

/**
 * Load a signing keypair for the configured algorithm (`RS256` → RSA, `ES256` → EC P-256).
 *
 * - If `signingKeyJson` is provided, parse it as a JWK (must contain a private key)
 *   and derive the public key for the JWKS response.
 * - Otherwise generate an ephemeral keypair for development.
 *
 * The JWKS only ever exposes public material: the env path re-imports the key
 * without its private component (`d`) and re-exports it, so RSA `p`/`q`/`dp`/`dq`/`qi`
 * and EC `d` can never leak — regardless of what the operator pasted in.
 *
 * In production always provide `MACP_AUTH_SIGNING_KEY_JSON` so the key survives
 * restarts and so the runtime's JWKS cache doesn't rotate unexpectedly.
 */
export async function loadKey(signingKeyJson?: string, alg: SigningAlg = 'RS256'): Promise<SigningMaterial> {
  if (!signingKeyJson) {
    const { publicKey, privateKey } = await jose.generateKeyPair(alg);
    const pubJwk = await jose.exportJWK(publicKey);
    pubJwk.kid = 'dev-key-1';
    pubJwk.alg = alg;
    pubJwk.use = 'sig';
    return { privateKey, jwks: { keys: [pubJwk] }, alg, source: 'ephemeral' };
  }

  const keyData = JSON.parse(signingKeyJson);
  const privateKey = await jose.importJWK(keyData, alg);
  const pubOnly = { ...keyData, d: undefined };
  const pubJwk = await jose.exportJWK(await jose.importJWK(pubOnly, alg));
  pubJwk.kid = keyData.kid ?? 'key-1';
  pubJwk.alg = alg;
  pubJwk.use = 'sig';
  return { privateKey, jwks: { keys: [pubJwk] }, alg, source: 'env' };
}
