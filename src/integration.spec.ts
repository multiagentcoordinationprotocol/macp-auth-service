import type { AddressInfo } from 'net';
import type { Server } from 'http';
import * as jose from 'jose';
import { createApp } from './server';
import { loadKey } from './keys';
import { AuthServiceConfig, SigningAlg } from './config';

/**
 * Integration tests over a real listening socket.
 *
 * The unit specs drive the Express app in-process via supertest. Here we bind a
 * real HTTP server on an ephemeral port and verify minted tokens with
 * `jose.createRemoteJWKSet` — an actual network fetch of `/.well-known/jwks.json`,
 * which is exactly how the runtime's verifier consumes this service. This catches
 * a class of failures supertest cannot (JWKS content-type/shape over the wire,
 * kid-based remote key selection).
 */

function testConfig(overrides: Partial<AuthServiceConfig> = {}): AuthServiceConfig {
  return {
    port: 0,
    issuer: 'macp-auth-service-int',
    audience: 'macp-runtime-int',
    maxTtlSeconds: 3600,
    defaultTtlSeconds: 300,
    signingAlg: 'RS256',
    ...overrides,
  };
}

describe.each<SigningAlg>(['RS256', 'ES256'])('integration over real HTTP — %s', (alg) => {
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    const signing = await loadKey(undefined, alg);
    const app = createApp(testConfig({ signingAlg: alg }), signing);
    server = app.listen(0);
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const { port } = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  });

  it('serves /healthz over the wire', async () => {
    const res = await fetch(`${baseUrl}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('mints a token that verifies via a REMOTE JWKS fetch, as the runtime does', async () => {
    const mintRes = await fetch(`${baseUrl}/tokens`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sender: 'agent://integration', scopes: { can_start_sessions: true }, ttl_seconds: 120 }),
    });
    expect(mintRes.status).toBe(200);
    const minted = (await mintRes.json()) as { token: string; expires_in_seconds: number };
    expect(minted.expires_in_seconds).toBe(120);

    const remoteJwks = jose.createRemoteJWKSet(new URL(`${baseUrl}/.well-known/jwks.json`));
    const { payload, protectedHeader } = await jose.jwtVerify(minted.token, remoteJwks, {
      issuer: 'macp-auth-service-int',
      audience: 'macp-runtime-int',
    });
    expect(protectedHeader.alg).toBe(alg);
    expect(payload.sub).toBe('agent://integration');
    expect(payload.macp_scopes).toEqual({ can_start_sessions: true });
  });

  it('serves the JWKS with a JSON content-type and only public material', async () => {
    const res = await fetch(`${baseUrl}/.well-known/jwks.json`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/application\/json/);
    const jwks = (await res.json()) as { keys: Array<Record<string, unknown>> };
    expect(jwks.keys).toHaveLength(1);
    expect(jwks.keys[0].d).toBeUndefined();
  });
});

describe('integration over real HTTP — pinned env key', () => {
  it('two instances sharing MACP_AUTH_SIGNING_KEY_JSON mint mutually verifiable tokens', async () => {
    // Simulates a horizontally scaled deployment: replica A mints, and a verifier
    // that fetched replica B's JWKS must still accept the token.
    const { privateKey } = await jose.generateKeyPair('RS256', { extractable: true });
    const jwk = await jose.exportJWK(privateKey);
    jwk.kid = 'shared-ops-key';
    const keyJson = JSON.stringify(jwk);

    const [a, b] = await Promise.all([loadKey(keyJson), loadKey(keyJson)]);
    const servers: Server[] = [];
    try {
      const urls = await Promise.all(
        [a, b].map(async (signing) => {
          const app = createApp(testConfig(), signing);
          const server = app.listen(0);
          servers.push(server);
          await new Promise<void>((resolve) => server.once('listening', resolve));
          return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
        }),
      );

      const mintRes = await fetch(`${urls[0]}/tokens`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sender: 'agent://replicated' }),
      });
      const { token } = (await mintRes.json()) as { token: string };

      const jwksFromB = jose.createRemoteJWKSet(new URL(`${urls[1]}/.well-known/jwks.json`));
      const { payload } = await jose.jwtVerify(token, jwksFromB, {
        issuer: 'macp-auth-service-int',
        audience: 'macp-runtime-int',
      });
      expect(payload.sub).toBe('agent://replicated');
    } finally {
      await Promise.all(
        servers.map(
          (server) => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
        ),
      );
    }
  });
});
