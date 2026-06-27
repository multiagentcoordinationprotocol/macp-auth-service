import * as jose from 'jose';
import { loadKey } from './keys';

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
