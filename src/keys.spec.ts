import * as jose from 'jose';
import { loadKey } from './keys';
import type { SigningAlg } from './config';

describe('JWKS key contract — kid / alg / use', () => {
  // Runtime v0.5.0 selects the verifying key in O(1) by `kid` and rejects any
  // header `alg` outside its allowlist. Every key we serve must therefore carry
  // a string `kid`, an `alg` in {RS256, ES256}, and `use: "sig"`. This turns the
  // guarantee the runtime's fast path relies on into an explicit contract.
  const cases: Array<{ name: string; alg: SigningAlg; build: () => Promise<string | undefined> }> = [
    { name: 'ephemeral RS256', alg: 'RS256', build: async () => undefined },
    { name: 'ephemeral ES256', alg: 'ES256', build: async () => undefined },
    {
      name: 'pinned RS256',
      alg: 'RS256',
      build: async () => {
        const { privateKey } = await jose.generateKeyPair('RS256', { extractable: true });
        const jwk = await jose.exportJWK(privateKey);
        jwk.kid = 'rs-contract-key';
        return JSON.stringify(jwk);
      },
    },
    {
      name: 'pinned ES256',
      alg: 'ES256',
      build: async () => {
        const { privateKey } = await jose.generateKeyPair('ES256', { extractable: true });
        const jwk = await jose.exportJWK(privateKey);
        jwk.kid = 'ec-contract-key';
        return JSON.stringify(jwk);
      },
    },
  ];

  it.each(cases)('every $name JWKS key has a string kid, allowlisted alg, and use=sig', async ({ alg, build }) => {
    const material = await loadKey(await build(), alg);
    expect(material.jwks.keys.length).toBeGreaterThan(0);
    for (const key of material.jwks.keys) {
      expect(typeof key.kid).toBe('string');
      expect((key.kid as string).length).toBeGreaterThan(0);
      expect(['RS256', 'ES256']).toContain(key.alg);
      expect(key.alg).toBe(alg);
      expect(key.use).toBe('sig');
    }
  });
});

describe('loadKey', () => {
  it('generates an ephemeral RSA keypair when no env key is provided', async () => {
    const material = await loadKey();
    expect(material.source).toBe('ephemeral');
    expect(material.alg).toBe('RS256');
    expect(material.jwks.keys).toHaveLength(1);
    expect(material.jwks.keys[0].kid).toBe('dev-key-1');
    expect(material.jwks.keys[0].alg).toBe('RS256');
    expect(material.jwks.keys[0].kty).toBe('RSA');
    expect(material.jwks.keys[0].use).toBe('sig');
    // Ephemeral keys change across calls.
    const second = await loadKey();
    expect(second.jwks.keys[0]).not.toEqual(material.jwks.keys[0]);
  });

  it('generates an ephemeral EC P-256 keypair for ES256 and never leaks the private scalar', async () => {
    const material = await loadKey(undefined, 'ES256');
    expect(material.source).toBe('ephemeral');
    expect(material.alg).toBe('ES256');
    const key = material.jwks.keys[0];
    expect(key.alg).toBe('ES256');
    expect(key.kty).toBe('EC');
    expect(key.crv).toBe('P-256');
    expect(key.use).toBe('sig');
    expect(key.d).toBeUndefined();
  });

  it('loads a fixed EC keypair from a JWK and never leaks the EC private scalar on JWKS', async () => {
    const { privateKey } = await jose.generateKeyPair('ES256', { extractable: true });
    const jwk = await jose.exportJWK(privateKey);
    jwk.kid = 'ec-ops-key-7';
    const material = await loadKey(JSON.stringify(jwk), 'ES256');
    expect(material.source).toBe('env');
    expect(material.alg).toBe('ES256');
    const key = material.jwks.keys[0];
    expect(key.kid).toBe('ec-ops-key-7');
    expect(key.kty).toBe('EC');
    expect(key.x).toBeDefined();
    expect(key.y).toBeDefined();
    expect(key.d).toBeUndefined();
  });

  it('defaults kid to "key-1" when the env JWK carries none', async () => {
    const { privateKey } = await jose.generateKeyPair('RS256', { extractable: true });
    const jwk = await jose.exportJWK(privateKey);
    delete jwk.kid;
    const material = await loadKey(JSON.stringify(jwk));
    expect(material.jwks.keys[0].kid).toBe('key-1');
  });

  it('rejects a signing key that is not valid JSON', async () => {
    await expect(loadKey('not json at all')).rejects.toThrow();
  });

  it('loads a fixed keypair from a JWK and never leaks private material on JWKS', async () => {
    const { privateKey } = await jose.generateKeyPair('RS256', { extractable: true });
    const jwk = await jose.exportJWK(privateKey);
    jwk.kid = 'ops-key-42';
    const envJson = JSON.stringify(jwk);

    const material = await loadKey(envJson);
    expect(material.source).toBe('env');
    expect(material.jwks.keys).toHaveLength(1);
    expect(material.jwks.keys[0].kid).toBe('ops-key-42');
    expect(material.jwks.keys[0].d).toBeUndefined();
    expect(material.jwks.keys[0].p).toBeUndefined();
    expect(material.jwks.keys[0].q).toBeUndefined();
    expect(material.jwks.keys[0].dp).toBeUndefined();
    expect(material.jwks.keys[0].dq).toBeUndefined();
    expect(material.jwks.keys[0].qi).toBeUndefined();
  });
});
