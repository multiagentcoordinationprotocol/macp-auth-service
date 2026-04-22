import { loadConfigFromEnv } from './config';

describe('loadConfigFromEnv', () => {
  it('returns defaults when env is empty', () => {
    const cfg = loadConfigFromEnv({});
    expect(cfg).toEqual({
      port: 3200,
      issuer: 'macp-auth-service',
      audience: 'macp-runtime',
      maxTtlSeconds: 3600,
      defaultTtlSeconds: 300,
      signingKeyJson: undefined,
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
});
