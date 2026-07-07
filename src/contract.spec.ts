import request from 'supertest';
import * as jose from 'jose';
import { createApp } from './server';
import { loadKey } from './keys';
import { AuthServiceConfig, SigningAlg } from './config';

/**
 * Cross-service contract test.
 *
 * Verified against macp-runtime v0.5.0 (`macp-runtime/crates/macp-auth`,
 * jsonwebtoken 9.3.x). The auth-service mints tokens that the runtime's JWT
 * resolver verifies and deserializes into:
 *
 *   struct MACPClaims  { sub: String, macp_scopes: Option<MACPScopes> }
 *   struct MACPScopes  {
 *     can_start_sessions:       Option<bool>,
 *     can_manage_mode_registry: Option<bool>,
 *     is_observer:              Option<bool>,
 *     allowed_modes:            Option<Vec<String>>,
 *     max_open_sessions:        Option<usize>,
 *   }
 *
 * If anyone adds, renames, or retypes a field on either side this test fails,
 * which is the whole point: it pins the wire contract that the runtime, the
 * control-plane minter, and the examples-service minter all depend on.
 *
 * Algorithm note: this service mints RS256 or ES256, both inside the runtime's
 * default `MACP_AUTH_JWT_ALGS` allowlist (RS256,ES256) as of v0.5.0. HS256 is
 * outside that default allowlist and this service cannot mint it either.
 */

const RUNTIME_SCOPE_FIELDS = [
  'can_start_sessions',
  'can_manage_mode_registry',
  'is_observer',
  'allowed_modes',
  'max_open_sessions',
] as const;

function testConfig(overrides: Partial<AuthServiceConfig> = {}): AuthServiceConfig {
  return {
    port: 0,
    issuer: 'macp-auth-service',
    audience: 'macp-runtime',
    maxTtlSeconds: 3600,
    defaultTtlSeconds: 300,
    signingAlg: 'RS256',
    ...overrides,
  };
}

// A scopes object that exercises every field the runtime struct can read.
const FULL_SCOPES = {
  can_start_sessions: true,
  can_manage_mode_registry: false,
  is_observer: false,
  allowed_modes: ['macp.mode.decision.v1', ''],
  max_open_sessions: 3,
};

describe.each<SigningAlg>(['RS256', 'ES256'])('runtime contract — %s', (alg) => {
  it('mints a token whose claims deserialize into exactly the runtime MACPClaims shape', async () => {
    const config = testConfig({ signingAlg: alg });
    const signing = await loadKey(undefined, alg);
    const app = createApp(config, signing);

    const mintRes = await request(app)
      .post('/tokens')
      .send({ sender: 'risk-agent', scopes: FULL_SCOPES, ttl_seconds: 600 });
    expect(mintRes.status).toBe(200);

    const jwks = jose.createLocalJWKSet(signing.jwks as jose.JSONWebKeySet);
    const { payload, protectedHeader } = await jose.jwtVerify(mintRes.body.token, jwks, {
      issuer: 'macp-auth-service',
      audience: 'macp-runtime',
    });

    // Header advertises the configured algorithm and the JWKS kid.
    expect(protectedHeader.alg).toBe(alg);
    expect(protectedHeader.kid).toBe(signing.jwks.keys[0].kid);

    // Top-level claims the runtime requires (sub) and validates (iss/aud/exp/iat).
    expect(payload.sub).toBe('risk-agent');
    expect(payload.iss).toBe('macp-auth-service');
    expect(payload.aud).toBe('macp-runtime');
    expect(typeof payload.iat).toBe('number');
    expect(typeof payload.exp).toBe('number');

    // macp_scopes must contain EXACTLY the fields the runtime struct declares —
    // no more (an unknown field would be a silent contract drift), no fewer.
    const scopes = payload.macp_scopes as Record<string, unknown>;
    expect(Object.keys(scopes).sort()).toEqual([...RUNTIME_SCOPE_FIELDS].sort());

    // Field types must match the Rust struct so serde deserialization succeeds.
    expect(typeof scopes.can_start_sessions).toBe('boolean');
    expect(typeof scopes.can_manage_mode_registry).toBe('boolean');
    expect(typeof scopes.is_observer).toBe('boolean');
    expect(Array.isArray(scopes.allowed_modes)).toBe(true);
    for (const mode of scopes.allowed_modes as unknown[]) {
      expect(typeof mode).toBe('string');
    }
    // usize on the runtime side: must be a non-negative integer.
    expect(Number.isInteger(scopes.max_open_sessions)).toBe(true);
    expect(scopes.max_open_sessions as number).toBeGreaterThanOrEqual(0);
  });
});

describe('runtime contract — scope passthrough is verbatim', () => {
  it('omits macp_scopes fields the caller did not send (no silent injection)', async () => {
    const signing = await loadKey();
    const app = createApp(testConfig(), signing);

    const res = await request(app)
      .post('/tokens')
      .send({ sender: 'observer-cp', scopes: { is_observer: true, can_start_sessions: false } });
    expect(res.status).toBe(200);

    const jwks = jose.createLocalJWKSet(signing.jwks as jose.JSONWebKeySet);
    const { payload } = await jose.jwtVerify(res.body.token, jwks, {
      issuer: 'macp-auth-service',
      audience: 'macp-runtime',
    });

    // Mirrors the control-plane's observer-only credential. The service must not
    // invent fields; the runtime fills omitted ones with its own defaults.
    expect(payload.macp_scopes).toEqual({ is_observer: true, can_start_sessions: false });
  });

  it('emits an empty macp_scopes object when scopes are omitted entirely', async () => {
    const signing = await loadKey();
    const app = createApp(testConfig(), signing);

    const res = await request(app).post('/tokens').send({ sender: 'minimal-agent' });
    expect(res.status).toBe(200);

    const jwks = jose.createLocalJWKSet(signing.jwks as jose.JSONWebKeySet);
    const { payload } = await jose.jwtVerify(res.body.token, jwks, {
      issuer: 'macp-auth-service',
      audience: 'macp-runtime',
    });
    // Runtime reads `macp_scopes: Option<MACPScopes>` with #[serde(default)] on every
    // field, so an empty object is valid and means "all defaults".
    expect(payload.macp_scopes).toEqual({});
  });
});
