# Getting Started

This guide walks you from a fresh checkout to a running auth-service with a minted and verified token. By the end you will have the service listening locally, a token minted via `curl`, and the signature verified against the published JWKS.

For protocol-level context on how agents authenticate to the runtime, see the [protocol security documentation](https://www.multiagentcoordinationprotocol.io/docs/security).

## Prerequisites

You need Node.js 20 or later and npm. The project uses TypeScript and `jose` for JWT signing — both are installed as dependencies.

```bash
# macOS
brew install node@20

# Ubuntu / Debian
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# Verify
node --version     # v20.x or later
npm --version
```

## Install and run

Clone the repository and install dependencies.

```bash
git clone https://github.com/multiagentcoordinationprotocol/macp-auth-service.git
cd macp-auth-service
npm install
```

### Development server

With no configuration, the service generates an ephemeral keypair on start (RSA by default, or EC P-256 when `MACP_AUTH_SIGNING_ALG=ES256`) and listens on `127.0.0.1:3200`. The keypair lives only as long as the process.

```bash
npm run dev
```

You should see:

```
[auth-service] listening on port 3200
[auth-service] issuer=macp-auth-service audience=macp-runtime
[auth-service] key source: ephemeral alg: RS256
[auth-service] JWKS: http://localhost:3200/.well-known/jwks.json
[auth-service] Mint: POST http://localhost:3200/tokens
```

The `key source: ephemeral` line is the signal that you did not provide `MACP_AUTH_SIGNING_KEY_JSON`. That is fine for local development; it is never correct in production.

### Production server

In production the service requires a pinned signing key so it survives restarts and so the runtime's JWKS cache stays warm. Generate one once, store it in your secret manager, and inject it at process start.

```bash
# Generate a production JWK (swap 'RS256' for 'ES256' to mint with an EC P-256 key)
node -e "const {generateKeyPair,exportJWK}=require('jose'); \
  (async()=>{const {privateKey}=await generateKeyPair('RS256',{extractable:true}); \
  const jwk=await exportJWK(privateKey); jwk.kid='prod-key-1'; \
  console.log(JSON.stringify(jwk))})()"

# Run with the pinned key (MACP_AUTH_SIGNING_ALG must match the key type; defaults to RS256)
export MACP_AUTH_SIGNING_KEY_JSON='{"kty":"RSA","kid":"prod-key-1",...}'
export MACP_AUTH_ISSUER=auth.example.com
export MACP_AUTH_AUDIENCE=macp-runtime
npm run build && npm start
```

See the [Deployment Guide](deployment.md) for the full environment variable reference and the production checklist.

### Verify your checkout

The test suite exercises the full HTTP surface — including an integration layer that binds a real socket and verifies tokens via a remote JWKS fetch, the same path the runtime uses.

```bash
npm test              # unit + integration + contract suites
npm run lint
npm run typecheck
```

There is also a black-box smoke test that drives any **running** instance (local, Docker, or deployed) using only Node built-ins — no npm install required on the machine running it:

```bash
npm run dev &                                # or point at any deployed instance
node scripts/smoke.js http://localhost:3200
```

It checks `/healthz`, the JWKS (including that no private material leaks), mints a short-lived token for `sender: "smoke-test"` and verifies its signature against the served JWKS, and confirms the validation errors respond correctly. CI runs this same script against the compiled build and against the Docker image before publishing it.

## Your first minted token

The mint flow is a single POST. The service validates the request, clamps the TTL to `MACP_AUTH_MAX_TTL_SECONDS`, signs a JWT with the in-memory private key, and returns the token together with the resolved TTL.

### Step 1: Mint a token

```bash
curl -sS -X POST http://localhost:3200/tokens \
  -H 'content-type: application/json' \
  -d '{
    "sender": "agent://risk",
    "scopes": {
      "can_start_sessions": true,
      "is_observer": false,
      "allowed_modes": ["macp.mode.decision.v1"],
      "max_open_sessions": 1,
      "can_manage_mode_registry": false
    },
    "ttl_seconds": 600
  }'
```

Response:

```json
{
  "token": "eyJhbGciOiJSUzI1NiIsImtpZCI6ImRldi1rZXktMSJ9...",
  "sender": "agent://risk",
  "expires_in_seconds": 600
}
```

The returned `expires_in_seconds` reflects the **effective** TTL after clamping. If you request `ttl_seconds: 999999` with the default config, you will get `3600` back, not `999999` — `MACP_AUTH_MAX_TTL_SECONDS` is authoritative.

### Step 2: Inspect the JWT

The payload carries the requested scopes under the `macp_scopes` claim, plus the standard JWT claims set by the service.

```bash
curl -sS -X POST http://localhost:3200/tokens \
  -H 'content-type: application/json' \
  -d '{"sender":"agent://risk"}' \
  | jq -r .token \
  | cut -d. -f2 \
  | base64 -d 2>/dev/null \
  | jq
```

Example decoded body:

```json
{
  "macp_scopes": {},
  "iat": 1713800000,
  "exp": 1713800300,
  "iss": "macp-auth-service",
  "aud": "macp-runtime",
  "sub": "agent://risk"
}
```

### Step 3: Fetch the JWKS

The public key is published at `/.well-known/jwks.json`. The runtime fetches this endpoint on first use and caches the result for `MACP_AUTH_JWKS_TTL_SECS` seconds.

```bash
curl -sS http://localhost:3200/.well-known/jwks.json | jq
```

```json
{
  "keys": [
    {
      "kty": "RSA",
      "n": "ukL3...pQ",
      "e": "AQAB",
      "kid": "dev-key-1",
      "alg": "RS256",
      "use": "sig"
    }
  ]
}
```

Note that no private material appears here — only `n`, `e`, and the metadata needed for signature verification.

### Step 4: Verify the signature

Round-trip the token through `jose.jwtVerify` to confirm the signature, issuer, and audience match.

```bash
node -e "
const jose = require('jose');
(async () => {
  const token = process.argv[1];
  const jwks = jose.createRemoteJWKSet(new URL('http://localhost:3200/.well-known/jwks.json'));
  const { payload } = await jose.jwtVerify(token, jwks, {
    issuer: 'macp-auth-service',
    audience: 'macp-runtime',
  });
  console.log(payload);
})();
" "$(curl -sS -X POST http://localhost:3200/tokens \
    -H 'content-type: application/json' \
    -d '{"sender":"agent://risk"}' | jq -r .token)"
```

If the signature verifies you will see the decoded payload. If it does not, the error is one of `JWSSignatureVerificationFailed`, `JWTExpired`, `JWTClaimValidationFailed`, etc. — the [API Reference](API.md#error-table) maps them to root causes.

## Pointing the runtime at your dev auth-service

Configure the Rust runtime to trust tokens issued by this service. Set the issuer, audience, and JWKS URL on the runtime and start it.

```bash
export MACP_AUTH_ISSUER=macp-auth-service
export MACP_AUTH_AUDIENCE=macp-runtime
export MACP_AUTH_JWKS_URL=http://127.0.0.1:3200/.well-known/jwks.json
export MACP_AUTH_JWKS_TTL_SECS=60
export MACP_AUTH_JWT_ALGS=RS256,ES256   # runtime ≥ 0.5.0 default; covers both algs this service mints
# The runtime starts here because JWT auth *is* configured above. MACP_ALLOW_INSECURE=1 below
# is only for plaintext (no-TLS) local operation — not to satisfy the auth gate.
export MACP_ALLOW_INSECURE=1
export MACP_BIND_ADDR=0.0.0.0:50051
cargo run --manifest-path ../macp-runtime/Cargo.toml
```

Now run any gRPC client with the minted JWT as a bearer token. The runtime will fetch your JWKS on the first request and cache it for 60 seconds.

> **Runtime ≥ 0.5.0 dev-mode gate:** if you start the runtime with *neither* a JWT issuer nor a static `MACP_AUTH_TOKENS_FILE`, it now refuses to start unless `MACP_ALLOW_INSECURE=1` — and the published runtime Docker image no longer bakes that flag in, so a bare `docker run` of the runtime fails fast. Pass auth config (as above) or the flag explicitly.

## Common errors

| Error | Cause | Fix |
|-------|-------|-----|
| `400 invalid JSON body` | Request body is not parseable JSON | Fix the JSON (unbalanced braces, trailing commas, unquoted keys are the usual suspects) |
| `400 sender is required` | `sender` missing, empty, whitespace-only, or not a string | Include a non-empty string for `sender` |
| `400 scopes must be an object` | `scopes` sent as a string, array, or `null` | Pass a JSON object (or omit the field for `{}`) |
| `400 ttl_seconds must be a positive number` | `ttl_seconds` zero, negative, or non-numeric (e.g. a quoted `"300"`) | Pass a positive number, or omit to use the default |
| `JWSSignatureVerificationFailed` at the runtime | Runtime's JWKS cache is stale after a key rotation | Wait `MACP_AUTH_JWKS_TTL_SECS` or restart the runtime |
| `JWTClaimValidationFailed: "iss" claim` | `MACP_AUTH_ISSUER` mismatch between auth-service and runtime | Align the two env vars |
| `JWTClaimValidationFailed: "aud" claim` | `MACP_AUTH_AUDIENCE` mismatch | Align the two env vars |
| `JWTExpired` | Token's `exp` has passed | Mint a fresh token; check clock skew between issuer and verifier |
| Ephemeral key rotates every restart | `MACP_AUTH_SIGNING_KEY_JSON` unset | Set it from a secret store for any shared deployment |

## Next steps

- [**Integration Guide**](integration.md) — end-to-end wiring with the control-plane, SDK orchestrators, SDK agents, and the runtime
- [**API Reference**](API.md) — full endpoint surface and JWT claim structure
- [**Architecture**](architecture.md) — module layout and signing flow
- [**Deployment Guide**](deployment.md) — production configuration and Docker
- [**Operations Runbook**](operations.md) — key rotation and diagnostics
