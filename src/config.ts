/**
 * Runtime configuration. Reads from environment with sensible defaults.
 * Kept pure (no side effects) so tests can construct overrides.
 */
export interface AuthServiceConfig {
  port: number;
  issuer: string;
  audience: string;
  maxTtlSeconds: number;
  defaultTtlSeconds: number;
  signingKeyJson?: string;
}

export function loadConfigFromEnv(env: NodeJS.ProcessEnv = process.env): AuthServiceConfig {
  return {
    port: Number(env.PORT ?? 3200),
    issuer: env.MACP_AUTH_ISSUER ?? 'macp-auth-service',
    audience: env.MACP_AUTH_AUDIENCE ?? 'macp-runtime',
    maxTtlSeconds: Number(env.MACP_AUTH_MAX_TTL_SECONDS ?? 3600),
    defaultTtlSeconds: Number(env.MACP_AUTH_DEFAULT_TTL_SECONDS ?? 300),
    signingKeyJson: env.MACP_AUTH_SIGNING_KEY_JSON,
  };
}
