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
    signingAlg: 'RS256',
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

    it.each([
      ['empty string', ''],
      ['whitespace-only string', '   '],
      ['number', 42],
      ['null', null],
      ['object', { name: 'alice' }],
      ['array', ['alice']]
    ])('rejects %s sender', async (_label, sender) => {
      const app = createApp(testConfig(), signing);
      const res = await request(app).post('/tokens').send({ sender });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('sender is required');
    });

    it('rejects a malformed JSON body with a JSON error, not an HTML error page', async () => {
      const app = createApp(testConfig(), signing);
      const res = await request(app).post('/tokens').set('content-type', 'application/json').send('{"sender": ');
      expect(res.status).toBe(400);
      expect(res.headers['content-type']).toMatch(/application\/json/);
      expect(res.body).toEqual({ error: 'invalid JSON body' });
    });

    it.each([
      ['string', 'admin'],
      ['array', ['can_start_sessions']],
      ['number', 7],
      ['null', null]
    ])('rejects non-object scopes (%s)', async (_label, scopes) => {
      const app = createApp(testConfig(), signing);
      const res = await request(app).post('/tokens').send({ sender: 'alice', scopes });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('scopes must be an object');
    });

    it.each([
      ['zero', 0],
      ['negative', -5],
      ['numeric string', '300'],
      ['boolean', true]
    ])('rejects invalid ttl_seconds (%s)', async (_label, ttl) => {
      const app = createApp(testConfig(), signing);
      const res = await request(app).post('/tokens').send({ sender: 'a', ttl_seconds: ttl });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/ttl_seconds/);
    });

    it('falls back to the default TTL when ttl_seconds is JSON null', async () => {
      // NaN/Infinity are not representable in JSON — they arrive as null, which
      // `??` treats the same as omitted.
      const app = createApp(testConfig(), signing);
      const res = await request(app).post('/tokens').send({ sender: 'a', ttl_seconds: null });
      expect(res.status).toBe(200);
      expect(res.body.expires_in_seconds).toBe(300);
    });

    it('clamps ttl_seconds to maxTtlSeconds', async () => {
      const app = createApp(testConfig({ maxTtlSeconds: 60 }), signing);
      const res = await request(app).post('/tokens').send({ sender: 'a', ttl_seconds: 9999 });
      expect(res.status).toBe(200);
      expect(res.body.expires_in_seconds).toBe(60);
    });

    it('passes through a ttl_seconds at or below maxTtlSeconds unclamped', async () => {
      const app = createApp(testConfig({ maxTtlSeconds: 3600 }), signing);
      const atMax = await request(app).post('/tokens').send({ sender: 'a', ttl_seconds: 3600 });
      expect(atMax.body.expires_in_seconds).toBe(3600);
      const belowMax = await request(app).post('/tokens').send({ sender: 'a', ttl_seconds: 42 });
      expect(belowMax.body.expires_in_seconds).toBe(42);
    });

    it('sets exp so that exp - iat equals expires_in_seconds', async () => {
      const app = createApp(testConfig(), signing);
      const res = await request(app).post('/tokens').send({ sender: 'a', ttl_seconds: 600 });
      const payload = jose.decodeJwt(res.body.token);
      expect((payload.exp as number) - (payload.iat as number)).toBe(res.body.expires_in_seconds);
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

    it('rejects a token signed by a different keypair (JWKS is authoritative)', async () => {
      const app = createApp(testConfig(), signing);
      const res = await request(app).post('/tokens').send({ sender: 'mallory' });
      const otherKey = await loadKey();
      const wrongJwks = jose.createLocalJWKSet(otherKey.jwks as jose.JSONWebKeySet);
      await expect(jose.jwtVerify(res.body.token, wrongJwks)).rejects.toThrow();
    });

    it('mints an ES256 token over the HTTP surface that verifies against its JWKS', async () => {
      const esSigning = await loadKey(undefined, 'ES256');
      const app = createApp(testConfig({ signingAlg: 'ES256' }), esSigning);
      const res = await request(app).post('/tokens').send({ sender: 'ec-agent' });
      expect(res.status).toBe(200);

      const jwks = jose.createLocalJWKSet(esSigning.jwks as jose.JSONWebKeySet);
      const { protectedHeader, payload } = await jose.jwtVerify(res.body.token, jwks, {
        issuer: 'macp-auth-service-test',
        audience: 'macp-runtime-test',
      });
      expect(protectedHeader.alg).toBe('ES256');
      expect(payload.sub).toBe('ec-agent');
    });
  });

  describe('unknown routes', () => {
    it('returns 404 for paths outside the API surface', async () => {
      const app = createApp(testConfig(), signing);
      expect((await request(app).get('/nope')).status).toBe(404);
      expect((await request(app).get('/tokens')).status).toBe(404);
    });
  });
});
