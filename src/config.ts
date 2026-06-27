/**
 * Runtime configuration. Reads from environment with sensible defaults.
 * Kept pure (no side effects) so tests can construct overrides.
 */
/** Signature algorithms this service can mint with. The runtime accepts RS256, ES256 and HS256. */
export type SigningAlg = 'RS256' | 'ES256';

export interface AuthServiceConfig {
  port: number;
  issuer: string;
  audience: string;
  maxTtlSeconds: number;
  defaultTtlSeconds: number;
  signingAlg: SigningAlg;
  signingKeyJson?: string;
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
  };
}
