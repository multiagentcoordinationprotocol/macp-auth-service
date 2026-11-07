/**
 * Runtime configuration. Reads from environment with sensible defaults.
 * Kept pure (no side effects) so tests can construct overrides.
 */
/**
 * Signature algorithms this service can mint with. The runtime's default JWT allowlist is
 * RS256/ES256 (runtime ≥ 0.5.0); HS256 requires `MACP_AUTH_JWT_ALGS=HS256` on the runtime and is
 * not mintable here regardless.
 */
export type SigningAlg = 'RS256' | 'ES256';

export interface AuthServiceConfig {
  port: number;
  issuer: string;
  audience: string;
  maxTtlSeconds: number;
  defaultTtlSeconds: number;
  signingAlg: SigningAlg;
  signingKeyJson?: string;
  /**
   * Shared keys a caller must present (`Authorization: Bearer <key>`) to mint on
   * `POST /tokens`. Read from `TOKEN_ISSUER_KEYS`, comma-separated so a key can be
   * rotated by running old and new side by side. Empty disables the check, which
   * `assertProductionConfig` refuses when `NODE_ENV=production`.
   */
  tokenIssuerKeys: string[];
}

function parseKeyList(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((key) => key.trim())
    .filter((key) => key.length > 0);
}

function parseSigningAlg(raw: string | undefined): SigningAlg {
  const value = raw ?? 'RS256';
  if (value !== 'RS256' && value !== 'ES256') {
    throw new Error(`MACP_AUTH_SIGNING_ALG must be RS256 or ES256 (got ${JSON.stringify(value)})`);
  }
  return value;
}

export function loadConfigFromEnv(env: NodeJS.ProcessEnv = process.env): AuthServiceConfig {
  return {
    port: Number(env.PORT ?? 3200),
    issuer: env.MACP_AUTH_ISSUER ?? 'macp-auth-service',
    audience: env.MACP_AUTH_AUDIENCE ?? 'macp-runtime',
    maxTtlSeconds: Number(env.MACP_AUTH_MAX_TTL_SECONDS ?? 3600),
    defaultTtlSeconds: Number(env.MACP_AUTH_DEFAULT_TTL_SECONDS ?? 300),
    signingAlg: parseSigningAlg(env.MACP_AUTH_SIGNING_ALG),
    signingKeyJson: env.MACP_AUTH_SIGNING_KEY_JSON,
    tokenIssuerKeys: parseKeyList(env.TOKEN_ISSUER_KEYS),
  };
}

/**
 * Production refuses to boot without a token-issuer key: without one, anything that can reach
 * the port can mint a runtime token for any sender and any scopes. Dev and test (any NODE_ENV
 * other than `production`) may run without keys; `POST /tokens` is then open, as before.
 */
export function assertProductionConfig(config: AuthServiceConfig, env: NodeJS.ProcessEnv = process.env): void {
  if (env.NODE_ENV === 'production' && config.tokenIssuerKeys.length === 0) {
    throw new Error(
      'TOKEN_ISSUER_KEYS is required when NODE_ENV=production: POST /tokens must not mint for unauthenticated callers',
    );
  }
}
