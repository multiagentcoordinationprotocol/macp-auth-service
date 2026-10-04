# MACP auth-service

JWT-minting identity service for the MACP runtime. Implements RFC-MACP-0004 §4
(direct-agent-auth) as a dedicated identity provider so that SDK-based agents
can authenticate directly to the runtime with short-lived RS256 (or ES256) bearer tokens.

## Role in the stack

```
  control-plane        ──POST /tokens──► auth-service :3200 ──┐
  SDK orchestrators    ──POST /tokens──► auth-service :3200   │
                                                              │  public keys
  macp-runtime (gRPC) ◄────GET /.well-known/jwks.json─────────┘  cached per
                                                                 MACP_AUTH_JWKS_TTL_SECS

  SDK agents (TS / Python) ──Authorization: Bearer <JWT>──► macp-runtime (gRPC)
```

- **Minting:** the [control-plane](https://github.com/multiagentcoordinationprotocol/macp-control-plane),
  the [playground](https://github.com/multiagentcoordinationprotocol/macp-playground) (which mints per agent spawn, see its
  [AUTH-2 guide](https://github.com/multiagentcoordinationprotocol/macp-playground/blob/main/docs/direct-agent-auth.md#auth-2--on-demand-jwt-minting)),
  or any orchestrator built on the [TypeScript SDK](https://github.com/multiagentcoordinationprotocol/macp-sdk-typescript)
  or [Python SDK](https://github.com/multiagentcoordinationprotocol/macp-sdk-python)
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
  fetches and caches the JWKS and validates every incoming JWT on each
  gRPC frame (claims contract: [RFC-MACP-0004 §4](https://github.com/multiagentcoordinationprotocol/multiagentcoordinationprotocol/blob/main/rfcs/RFC-MACP-0004-security.md)). See the runtime
  [Getting Started](https://github.com/multiagentcoordinationprotocol/macp-runtime/blob/main/docs/getting-started.md#jwt-mode)
  and
  [Deployment](https://github.com/multiagentcoordinationprotocol/macp-runtime/blob/main/docs/deployment.md#authentication)
  guides.

This service is *not* in the hot path of a running session — tokens are minted
once per agent at provisioning time, then reused for the session lifetime.

## API

Three endpoints — `GET /healthz`, `GET /.well-known/jwks.json`, and
`POST /tokens` (mint a JWT from `sender` + `scopes` + `ttl_seconds`). Request and
response fields, the scopes schema, JWT claims, and the error table live in the
[API Reference](docs/API.md); that page is the single source of truth.

## Configuration

Configuration is environment-driven (`PORT`, `MACP_AUTH_ISSUER`,
`MACP_AUTH_AUDIENCE`, `MACP_AUTH_MAX_TTL_SECONDS`, `MACP_AUTH_DEFAULT_TTL_SECONDS`,
`MACP_AUTH_SIGNING_ALG`, `MACP_AUTH_SIGNING_KEY_JSON`). The variable reference is in
[Deployment › Environment variables](docs/deployment.md#environment-variables), and
[`.env.example`](.env.example) is a copy-paste starting point.
`MACP_AUTH_SIGNING_KEY_JSON` is **required in production** — without it the service
generates an ephemeral keypair that changes on every restart. Key generation and
rotation: [Deployment › Signing key generation](docs/deployment.md#signing-key-generation)
and [Operations › Key rotation](docs/operations.md#key-rotation).

## Development

```bash
npm install          # one-time
npm run dev          # ts-node (no auto-reload)
npm test             # jest — unit + HTTP integration via supertest
npm run test:coverage
npm run build        # compile to dist/
npm start            # run the compiled build
npm run typecheck    # tsc --noEmit
npm run lint         # eslint
node scripts/smoke.js http://localhost:3200   # black-box check of a running instance
```

### End-to-end against a live runtime (opt-in)

`scripts/e2e-runtime.sh` mints RS256 and ES256 tokens and verifies them against a
real macp-runtime container (requires Docker + `grpcurl`; not wired into
`npm test`). It also asserts a garbage bearer is rejected with `UNAUTHENTICATED`.
See the script header for the manual stale-cache-grace probe.

The script resolves `macp.v1.MACPRuntimeService` client-side from the versioned
`.proto` schema rather than gRPC reflection, so it works against the default published
`ghcr.io/multiagentcoordinationprotocol/macp-runtime:latest` image. Rationale and
`.proto` sourcing: `ASSUMPTIONS.md` / `DECISIONS.md` and the script header. In CI, the offline `src/contract.spec.ts`
wire-shape test is the load-bearing contract check.

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

**`POST /tokens` has no client authentication** — anyone who can reach it can mint a
token for any `sender`. Keep it on a trusted network or front it with mTLS / an
authenticating proxy; see [`SECURITY.md`](SECURITY.md) and the
[Production checklist](docs/deployment.md#production-checklist). Supply
`MACP_AUTH_SIGNING_KEY_JSON` from a secret store in any shared environment.
