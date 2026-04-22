import request from 'supertest';
import * as jose from 'jose';
import { createApp } from './server';
import { loadKey, SigningMaterial } from './keys';
import { AuthServiceConfig } from './config';

function testConfig(overrides: Partial<AuthServiceConfig> = {}): AuthServiceConfig {
  return {
    port: 0,
    issuer: 'macp-auth-service-test',
    audience: 'macp-runtime-test',
    maxTtlSeconds: 3600,
    defaultTtlSeconds: 300,
    ...overrides,
  };
}

describe('auth-service HTTP surface', () => {
  let signing: SigningMaterial;

  beforeAll(async () => {
    signing = await loadKey();
  });

  describe('GET /healthz', () => {
    it('returns ok', async () => {
      const app = createApp(testConfig(), signing);
      const res = await request(app).get('/healthz');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });
    });
  });

  describe('GET /.well-known/jwks.json', () => {
    it('returns a JWKS with one RS256 signing key', async () => {
      const app = createApp(testConfig(), signing);
      const res = await request(app).get('/.well-known/jwks.json');
      expect(res.status).toBe(200);
      expect(res.body.keys).toHaveLength(1);
      const key = res.body.keys[0];
      expect(key.alg).toBe('RS256');
      expect(key.use).toBe('sig');
      expect(key.kty).toBe('RSA');
      expect(key.kid).toBeDefined();
      // Private key material must NEVER leak on the JWKS endpoint.
      expect(key.d).toBeUndefined();
      expect(key.p).toBeUndefined();
      expect(key.q).toBeUndefined();
    });
  });

  describe('POST /tokens', () => {
    it('mints a JWT with the default TTL when ttl_seconds is omitted', async () => {
      const app = createApp(testConfig(), signing);
      const res = await request(app).post('/tokens').send({ sender: 'alice' });
      expect(res.status).toBe(200);
      expect(res.body.sender).toBe('alice');
      expect(res.body.expires_in_seconds).toBe(300);
      expect(typeof res.body.token).toBe('string');
      expect(res.body.token.split('.')).toHaveLength(3);
    });

    it('rejects missing sender', async () => {
      const app = createApp(testConfig(), signing);
      const res = await request(app).post('/tokens').send({});
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/sender/);
    });

    it('rejects empty-string sender', async () => {
      const app = createApp(testConfig(), signing);
      const res = await request(app).post('/tokens').send({ sender: '' });
      expect(res.status).toBe(400);
    });

    it('rejects non-positive ttl_seconds', async () => {
      const app = createApp(testConfig(), signing);
      const res = await request(app).post('/tokens').send({ sender: 'a', ttl_seconds: 0 });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/ttl_seconds/);
    });

    it('clamps ttl_seconds to maxTtlSeconds', async () => {
      const app = createApp(testConfig({ maxTtlSeconds: 60 }), signing);
      const res = await request(app).post('/tokens').send({ sender: 'a', ttl_seconds: 9999 });
      expect(res.status).toBe(200);
      expect(res.body.expires_in_seconds).toBe(60);
    });

    it('embeds scopes under macp_scopes claim', async () => {
      const app = createApp(testConfig(), signing);
      const res = await request(app)
        .post('/tokens')
        .send({
          sender: 'risk-agent',
          scopes: {
            can_start_sessions: true,
            allowed_modes: ['macp.mode.decision.v1', ''],
          },
        });
      expect(res.status).toBe(200);

      const jwks = jose.createLocalJWKSet(signing.jwks as jose.JSONWebKeySet);
      const { payload } = await jose.jwtVerify(res.body.token, jwks, {
        issuer: 'macp-auth-service-test',
        audience: 'macp-runtime-test',
      });
      expect(payload.sub).toBe('risk-agent');
      expect(payload.macp_scopes).toEqual({
        can_start_sessions: true,
        allowed_modes: ['macp.mode.decision.v1', ''],
      });
    });

    it('produces a JWT that verifies against the advertised JWKS', async () => {
      const app = createApp(testConfig(), signing);
      const mintRes = await request(app).post('/tokens').send({ sender: 'bob' });
      const jwksRes = await request(app).get('/.well-known/jwks.json');

      const jwks = jose.createLocalJWKSet(jwksRes.body as jose.JSONWebKeySet);
      const { payload, protectedHeader } = await jose.jwtVerify(mintRes.body.token, jwks, {
        issuer: 'macp-auth-service-test',
        audience: 'macp-runtime-test',
      });
      expect(protectedHeader.alg).toBe('RS256');
      expect(protectedHeader.kid).toBe(jwksRes.body.keys[0].kid);
      expect(payload.sub).toBe('bob');
      expect(payload.iss).toBe('macp-auth-service-test');
      expect(payload.aud).toBe('macp-runtime-test');
      expect(payload.iat).toBeDefined();
      expect(payload.exp).toBeDefined();
    });

    it('rejects a token with the wrong audience', async () => {
      const app = createApp(testConfig(), signing);
      const res = await request(app).post('/tokens').send({ sender: 'carol' });
      const jwks = jose.createLocalJWKSet(signing.jwks as jose.JSONWebKeySet);
      await expect(
        jose.jwtVerify(res.body.token, jwks, { audience: 'some-other-audience' }),
      ).rejects.toThrow();
    });
  });
});
