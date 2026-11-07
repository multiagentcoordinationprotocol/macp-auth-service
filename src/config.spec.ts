import { assertProductionConfig, loadConfigFromEnv } from './config';

describe('loadConfigFromEnv', () => {
  it('returns defaults when env is empty', () => {
    const cfg = loadConfigFromEnv({});
    expect(cfg).toEqual({
      port: 3200,
      issuer: 'macp-auth-service',
      audience: 'macp-runtime',
      maxTtlSeconds: 3600,
      defaultTtlSeconds: 300,
      signingAlg: 'RS256',
      signingKeyJson: undefined,
      tokenIssuerKeys: [],
    });
  });

  it('reads overrides from env', () => {
    const cfg = loadConfigFromEnv({
      PORT: '4200',
      MACP_AUTH_ISSUER: 'https://auth.example.com',
      MACP_AUTH_AUDIENCE: 'macp-runtime-prod',
      MACP_AUTH_MAX_TTL_SECONDS: '60',
      MACP_AUTH_DEFAULT_TTL_SECONDS: '30',
      MACP_AUTH_SIGNING_KEY_JSON: '{"kty":"RSA"}',
    });
    expect(cfg.port).toBe(4200);
    expect(cfg.issuer).toBe('https://auth.example.com');
    expect(cfg.audience).toBe('macp-runtime-prod');
    expect(cfg.maxTtlSeconds).toBe(60);
    expect(cfg.defaultTtlSeconds).toBe(30);
    expect(cfg.signingKeyJson).toBe('{"kty":"RSA"}');
  });

  it('defaults signingAlg to RS256 and accepts ES256', () => {
    expect(loadConfigFromEnv({}).signingAlg).toBe('RS256');
    expect(loadConfigFromEnv({ MACP_AUTH_SIGNING_ALG: 'ES256' }).signingAlg).toBe('ES256');
  });

  it('rejects an unsupported signingAlg', () => {
    expect(() => loadConfigFromEnv({ MACP_AUTH_SIGNING_ALG: 'HS256' })).toThrow(/RS256 or ES256/);
    expect(() => loadConfigFromEnv({ MACP_AUTH_SIGNING_ALG: 'none' })).toThrow(/RS256 or ES256/);
  });

  it('parses TOKEN_ISSUER_KEYS as a trimmed, comma-separated list', () => {
    expect(loadConfigFromEnv({ TOKEN_ISSUER_KEYS: ' k1 , k2,,' }).tokenIssuerKeys).toEqual(['k1', 'k2']);
    expect(loadConfigFromEnv({ TOKEN_ISSUER_KEYS: ' , ' }).tokenIssuerKeys).toEqual([]);
  });
});

describe('assertProductionConfig', () => {
  it('refuses to boot in production without TOKEN_ISSUER_KEYS', () => {
    const cfg = loadConfigFromEnv({});
    expect(() => assertProductionConfig(cfg, { NODE_ENV: 'production' })).toThrow(/TOKEN_ISSUER_KEYS is required/);
  });

  it('boots in production with a key', () => {
    const cfg = loadConfigFromEnv({ TOKEN_ISSUER_KEYS: 'k1' });
    expect(() => assertProductionConfig(cfg, { NODE_ENV: 'production' })).not.toThrow();
  });

  it.each([undefined, 'development', 'test'])('allows no key when NODE_ENV=%s', (nodeEnv) => {
    const cfg = loadConfigFromEnv({});
    expect(() => assertProductionConfig(cfg, { NODE_ENV: nodeEnv })).not.toThrow();
  });
});
