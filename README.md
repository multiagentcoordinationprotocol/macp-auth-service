# MACP auth-service

JWT-minting identity service for the MACP runtime. Implements RFC-MACP-0004 §4
(direct-agent-auth) as a dedicated identity provider so that SDK-based agents
can authenticate directly to the runtime with short-lived RS256 bearer tokens.

## Role in the stack

```
  control-plane        ──POST /tokens──► auth-service :3200 ──┐
  SDK orchestrators    ──POST /tokens──► auth-service :3200   │
                                                              │  public keys
  macp-runtime (gRPC) ◄────GET /.well-known/jwks.json─────────┘  cached per
                                                                 MACP_AUTH_JWKS_TTL_SECS

  SDK agents (TS / Python) ──Authorization: Bearer <JWT>──► macp-runtime (gRPC)
```

- **Minting:** the [control-plane](https://github.com/multiagentcoordinationprotocol/macp-control-plane)
  (or any orchestrator built on the [TypeScript SDK](https://github.com/multiagentcoordinationprotocol/macp-sdk-typescript)
  or [Python SDK](https://github.com/multiagentcoordinationprotocol/macp-sdk-python))
  calls `POST /tokens` once per agent it spawns, passing `sender` + scopes.
  The returned JWT is handed to the agent in its bootstrap payload under
  `runtime.bearerToken`.
- **Bearer presentation:** SDK-based agents load the bearer from bootstrap
  and present it as `Authorization: Bearer <JWT>` on every gRPC call to the
  runtime. See the SDK auth guides
  ([TypeScript](https://github.com/multiagentcoordinationprotocol/macp-sdk-typescript/blob/main/docs/guides/authentication.md),
  [Python](https://github.com/multiagentcoordinationprotocol/macp-sdk-python/blob/main/docs/guides/direct-agent-auth.md)).
- **Verification:** the runtime is configured with
  `MACP_AUTH_JWKS_URL=http://auth-service:3200/.well-known/jwks.json`. It
  fetches the JWKS (cached per `MACP_AUTH_JWKS_TTL_SECS`) and validates every
  incoming JWT's signature + header `alg` (against `MACP_AUTH_JWT_ALGS`,
  default `RS256,ES256` on runtime ≥ 0.5.0) + `iss` + `aud` + `exp` on each
  gRPC frame. See the runtime
  [Getting Started](https://github.com/multiagentcoordinationprotocol/macp-runtime/blob/main/docs/getting-started.md#jwt-mode)
  and
  [Deployment](https://github.com/multiagentcoordinationprotocol/macp-runtime/blob/main/docs/deployment.md#authentication)
  guides.

This service is *not* in the hot path of a running session — tokens are minted
once per agent at provisioning time, then reused for the session lifetime.

## API

### `GET /healthz`

Liveness probe. Returns `{ "ok": true }` with HTTP 200.

### `GET /.well-known/jwks.json`

Returns the public JWKS (private material is never exposed here).

```json
{
  "keys": [{
    "kty": "RSA", "alg": "RS256", "use": "sig", "kid": "dev-key-1",
    "n": "…", "e": "AQAB"
  }]
}
```

### `POST /tokens`

Mint a JWT.

Request:

```json
{
  "sender": "risk-agent",
  "scopes": {
    "can_start_sessions": true,
    "is_observer": false,
    "allowed_modes": ["macp.mode.decision.v1", ""],
    "max_open_sessions": 1,
    "can_manage_mode_registry": false
  },
  "ttl_seconds": 3600
}
```

- `sender` (required) — becomes the JWT `sub` claim and the authenticated
  identity the runtime associates with incoming frames.
- `scopes` (optional) — serialized verbatim under the `macp_scopes` claim.
- `ttl_seconds` (optional) — clamped by `MACP_AUTH_MAX_TTL_SECONDS`. Defaults
  to `MACP_AUTH_DEFAULT_TTL_SECONDS` when omitted.

Response:

```json
{
  "token": "eyJhbGciOi…",
  "sender": "risk-agent",
  "expires_in_seconds": 3600
}
```

Errors:
- `400` `{"error":"sender is required"}` if `sender` is missing or empty.
- `400` `{"error":"ttl_seconds must be a positive number"}` if `ttl_seconds` is
  non-positive or non-finite.

## Configuration

See `.env.example` for the complete reference. Minimum in production:

| Variable | Default | Required? | Notes |
|---|---|---|---|
| `PORT` | `3200` | no | HTTP listen port |
| `MACP_AUTH_ISSUER` | `macp-auth-service` | no | JWT `iss`. Must match runtime's expected issuer. |
| `MACP_AUTH_AUDIENCE` | `macp-runtime` | no | JWT `aud`. Must match runtime's expected audience. |
| `MACP_AUTH_MAX_TTL_SECONDS` | `3600` | no | Upper bound on minted token lifetime. |
| `MACP_AUTH_DEFAULT_TTL_SECONDS` | `300` | no | Applied when request omits `ttl_seconds`. |
| `MACP_AUTH_SIGNING_ALG` | `RS256` | no | Signature algorithm. `RS256` (RSA) or `ES256` (EC P-256). The runtime accepts both; the JWKS advertises whichever is configured. |
| `MACP_AUTH_SIGNING_KEY_JSON` | *(ephemeral)* | **yes in prod** | Private JWK matching `MACP_AUTH_SIGNING_ALG` (RSA for `RS256`, EC P-256 for `ES256`). If unset, generates an ephemeral keypair on startup (dev only — keys rotate on every restart). |

### Generating a production signing key

```bash
node -e "const {generateKeyPair, exportJWK} = require('jose'); \
  (async () => { \
    const { privateKey } = await generateKeyPair('RS256', { extractable: true }); \
    const jwk = await exportJWK(privateKey); \
    jwk.kid = 'prod-key-1'; \
    console.log(JSON.stringify(jwk)); \
  })();"
```

Set the output as `MACP_AUTH_SIGNING_KEY_JSON`. Rotate by generating a new
key with a fresh `kid` and redeploying; the runtime's JWKS cache refreshes
within `MACP_AUTH_JWKS_TTL_SECS` while the JWKS endpoint stays reachable. On
runtime ≥ 0.5.0 a verifier that can't refresh keeps the old key set for up to
`TTL + 3600 s` (stale-cache grace) — see the
[Operations Runbook](docs/operations.md#key-rotation) for emergency rotation.

For an EC P-256 key (`MACP_AUTH_SIGNING_ALG=ES256`), substitute `'ES256'` for
`'RS256'` in the snippet above — `generateKeyPair`/`exportJWK` emit the
matching `kty: "EC"` JWK, and the service advertises it on the JWKS unchanged.

## Development

```bash
npm install          # one-time
npm run dev          # ts-node watch (not restart)
npm test             # jest — unit + HTTP integration via supertest
npm run test:coverage
npm run build        # compile to dist/
npm start            # run the compiled build
npm run typecheck    # tsc --noEmit
```

### End-to-end against a live runtime (opt-in)

`scripts/e2e-runtime.sh` mints RS256 and ES256 tokens and verifies them against a
real macp-runtime v0.5.0 container (requires Docker + `grpcurl`; not wired into
`npm test`). It also asserts a garbage bearer is rejected with `UNAUTHENTICATED`.
See the script header for the manual stale-cache-grace probe.

## Docker

```bash
docker build -t macp-auth-service:local .
docker run --rm -p 3200:3200 macp-auth-service:local
curl http://localhost:3200/healthz
```

The published CI image is `ghcr.io/multiagentcoordinationprotocol/macp-auth-service`
(see `.github/workflows/docker.yml`).

## Documentation

Full documentation lives under [`docs/`](docs/README.md):

| Page | Purpose |
|------|---------|
| [Getting Started](docs/getting-started.md) | Install, run locally, mint your first token, verify against JWKS |
| [Integration Guide](docs/integration.md) | End-to-end wiring with the control-plane, SDK orchestrators, SDK agents, and the runtime |
| [Architecture](docs/architecture.md) | Module layout, request flow, key lifecycle, design goals |
| [API Reference](docs/API.md) | All three HTTP endpoints, JWT claim structure, error table |
| [Deployment](docs/deployment.md) | Production checklist, env vars, Docker, Kubernetes, TLS termination |
| [Operations Runbook](docs/operations.md) | Key rotation, diagnostics, common failures, incident response |

## Security notes

- **`POST /tokens` has no client authentication in this implementation.** It
  assumes a trusted intra-cluster network. If the service is reachable from
  anywhere else, put it behind mTLS / a reverse proxy that authenticates
  callers, or add a shared-secret `Authorization` header check. Anyone who
  can hit `/tokens` today can mint a JWT for any `sender`.
- Run with `MACP_AUTH_SIGNING_KEY_JSON` supplied by a secret store
  (Kubernetes Secret, Vault, etc.) in any shared environment.
- Container runs as a non-root user and exposes an HTTP healthcheck; no
  extra runtime privileges are needed.
