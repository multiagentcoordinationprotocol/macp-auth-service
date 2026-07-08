#!/usr/bin/env node
/**
 * smoke.js — black-box smoke test of a RUNNING auth-service instance.
 *
 * Dependency-free (Node >= 20 built-ins only) so CI can run it against either
 * `node dist/index.js` or the Docker image without an npm install. Verifies:
 *
 *   1. /healthz responds ok within the wait window
 *   2. /.well-known/jwks.json serves at least one public key (no private material)
 *   3. POST /tokens mints a JWT whose signature verifies against the served JWKS
 *      (RS256 and ES256), with the expected sub/iss/aud/exp claims
 *   4. Validation rejects a missing sender and malformed JSON with 400 + JSON errors
 *
 * Usage: node scripts/smoke.js [base-url]   (default http://localhost:3200)
 */
const crypto = require('node:crypto');

const BASE_URL = process.argv[2] || 'http://localhost:3200';
const WAIT_ATTEMPTS = 30;
const WAIT_DELAY_MS = 500;

function fail(msg) {
  console.error(`[smoke] FAIL: ${msg}`);
  process.exit(1);
}

function pass(msg) {
  console.log(`[smoke] PASS: ${msg}`);
}

function b64urlJson(segment) {
  return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
}

function verifySignature(token, jwk) {
  const [header, payload, signature] = token.split('.');
  const alg = b64urlJson(header).alg;
  const publicKey = crypto.createPublicKey({ key: jwk, format: 'jwk' });
  const data = Buffer.from(`${header}.${payload}`);
  const sig = Buffer.from(signature, 'base64url');
  if (alg === 'RS256') return crypto.verify('RSA-SHA256', data, publicKey, sig);
  if (alg === 'ES256') return crypto.verify('SHA256', data, { key: publicKey, dsaEncoding: 'ieee-p1363' }, sig);
  fail(`unexpected token alg ${alg}`);
}

async function waitForHealthz() {
  for (let i = 0; i < WAIT_ATTEMPTS; i++) {
    try {
      const res = await fetch(`${BASE_URL}/healthz`);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, WAIT_DELAY_MS));
  }
  fail(`/healthz not reachable at ${BASE_URL} after ${(WAIT_ATTEMPTS * WAIT_DELAY_MS) / 1000}s`);
}

async function main() {
  await waitForHealthz();
  pass('/healthz reachable');

  const jwksRes = await fetch(`${BASE_URL}/.well-known/jwks.json`);
  if (!jwksRes.ok) fail(`JWKS endpoint returned ${jwksRes.status}`);
  const jwks = await jwksRes.json();
  if (!Array.isArray(jwks.keys) || jwks.keys.length === 0) fail('JWKS has no keys');
  for (const key of jwks.keys) {
    if (key.d !== undefined || key.p !== undefined || key.q !== undefined) {
      fail('JWKS leaks private key material');
    }
  }
  pass(`JWKS serves ${jwks.keys.length} public key(s)`);

  const mintRes = await fetch(`${BASE_URL}/tokens`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sender: 'smoke-test', scopes: { can_start_sessions: true }, ttl_seconds: 60 }),
  });
  if (!mintRes.ok) fail(`POST /tokens returned ${mintRes.status}`);
  const minted = await mintRes.json();
  if (typeof minted.token !== 'string' || minted.token.split('.').length !== 3) fail('mint response has no JWT');
  if (minted.expires_in_seconds !== 60) fail(`expected expires_in_seconds=60, got ${minted.expires_in_seconds}`);

  const header = b64urlJson(minted.token.split('.')[0]);
  const signingKey = jwks.keys.find((key) => key.kid === header.kid);
  if (!signingKey) fail(`token kid ${header.kid} not present in JWKS`);
  if (!verifySignature(minted.token, signingKey)) fail('token signature does not verify against JWKS');
  pass(`minted ${header.alg} token verifies against the served JWKS (kid=${header.kid})`);

  const payload = b64urlJson(minted.token.split('.')[1]);
  if (payload.sub !== 'smoke-test') fail(`expected sub=smoke-test, got ${payload.sub}`);
  if (typeof payload.iss !== 'string' || typeof payload.aud !== 'string') fail('missing iss/aud claims');
  if (payload.exp - payload.iat !== 60) fail('exp - iat does not match requested ttl');
  if (payload.macp_scopes.can_start_sessions !== true) fail('macp_scopes not carried through');
  pass('claims are well-formed (sub/iss/aud/iat/exp/macp_scopes)');

  const badSender = await fetch(`${BASE_URL}/tokens`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  });
  if (badSender.status !== 400) fail(`missing sender: expected 400, got ${badSender.status}`);

  const badJson = await fetch(`${BASE_URL}/tokens`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{"sender": ',
  });
  if (badJson.status !== 400) fail(`malformed JSON: expected 400, got ${badJson.status}`);
  const badJsonBody = await badJson.json().catch(() => fail('malformed JSON error is not JSON'));
  if (!badJsonBody.error) fail('malformed JSON error body has no "error" field');
  pass('validation rejects missing sender and malformed JSON with 400 + JSON errors');

  console.log('[smoke] ALL CHECKS PASSED');
}

main().catch((err) => fail(err.stack || String(err)));
