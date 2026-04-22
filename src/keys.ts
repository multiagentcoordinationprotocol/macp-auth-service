import * as jose from 'jose';

export interface SigningMaterial {
  privateKey: jose.KeyLike | Uint8Array;
  jwks: { keys: jose.JWK[] };
  source: 'ephemeral' | 'env';
}

/**
 * Load an RS256 signing keypair.
 *
 * - If `signingKeyJson` is provided, parse it as a JWK (must contain a private key)
 *   and derive the public key for the JWKS response.
 * - Otherwise generate an ephemeral keypair for development.
 *
 * In production always provide `MACP_AUTH_SIGNING_KEY_JSON` so the key survives
 * restarts and so the runtime's JWKS cache doesn't rotate unexpectedly.
 */
export async function loadKey(signingKeyJson?: string): Promise<SigningMaterial> {
  if (!signingKeyJson) {
    const { publicKey, privateKey } = await jose.generateKeyPair('RS256');
    const pubJwk = await jose.exportJWK(publicKey);
    pubJwk.kid = 'dev-key-1';
    pubJwk.alg = 'RS256';
    pubJwk.use = 'sig';
    return { privateKey, jwks: { keys: [pubJwk] }, source: 'ephemeral' };
  }

  const keyData = JSON.parse(signingKeyJson);
  const privateKey = await jose.importJWK(keyData, 'RS256');
  const pubOnly = { ...keyData, d: undefined };
  const pubJwk = await jose.exportJWK(await jose.importJWK(pubOnly, 'RS256'));
  pubJwk.kid = keyData.kid ?? 'key-1';
  pubJwk.alg = 'RS256';
  pubJwk.use = 'sig';
  return { privateKey, jwks: { keys: [pubJwk] }, source: 'env' };
}
