# Architecture

This page describes the internal shape of the auth-service: the module split, the request lifecycle, the key lifecycle, and the reasoning behind the design choices. For the protocol-level authentication model — why agents hold short-lived JWTs, why the runtime verifies via JWKS, and what guarantees that gives — see the [protocol security documentation](https://www.multiagentcoordinationprotocol.io/docs/security).

## Design goals

The service has four goals, in order of priority.

1. **Stateless.** No database, no session store, no revocation list. A restarted process is indistinguishable from a fresh one, provided the signing key is pinned.
2. **Single responsibility.** Mint tokens. Publish the verification key. Nothing else. No user management, no policy evaluation, no rate limiting.
3. **Testable without I/O.** The HTTP handlers can be exercised by supertest against a constructed app without starting a listener or touching the environment.
4. **Container-native.** Runs as a non-root user, exposes an unauthenticated health probe, ships a multi-stage `node:20-alpine` image, and reads all configuration from environment variables.

Everything else — the specific library choices (`express`, `jose`), the file layout, the request-handling order — falls out of these four goals.

## Source layout

```
src/
  config.ts      — loadConfigFromEnv(): parses env into an AuthServiceConfig
  keys.ts        — loadKey(): returns SigningMaterial from env JWK or ephemeral gen
  server.ts      — createApp(config, signing): pure Express app factory
  index.ts       — main(): wires config + keys + app + listen + graceful shutdown
  *.spec.ts      — co-located jest + supertest tests
```

The split between `config`, `keys`, `server`, and `index` is the central architectural decision. It is not accidental and should not be collapsed.

- `config.ts` is the only place that reads `MACP_AUTH_*` / `PORT` env vars (other than `index.ts` reading nothing). `loadConfigFromEnv(env)` takes the env as a parameter with a default of `process.env`, so tests can pass a synthetic environment.
- `keys.ts` knows nothing about HTTP or Express. It takes a JWK string (or `undefined`) and returns `{ privateKey, jwks, source }`. Tests can feed it a fixed JWK and get a deterministic key back.
- `server.ts` exports `createApp(config, signing)` — a pure function that builds an `Express` app bound to the given config and signing material. It never calls `.listen()`, never reads `process.env`, and never touches the filesystem.
- `index.ts` is the only file that owns side effects: it calls `loadConfigFromEnv()`, `loadKey()`, `createApp()`, `.listen()`, and wires `SIGTERM` / `SIGINT` handlers.

This split means tests construct a real Express app with a real RSA key, round-trip real HTTP, and assert real JWT signatures — without opening a network socket or depending on the environment. `server.spec.ts` is the reference for this pattern.

## Request lifecycle

The service handles three distinct request types. None of them touch any persistence layer; all responses are derived from in-memory state plus the current request.

### `GET /healthz`

```
request → express.json middleware → handler → { ok: true } response
```

No input parsing, no key use, no error path.

### `GET /.well-known/jwks.json`

```
request → handler → signing.jwks response
```

Returns the pre-computed JWKS from `SigningMaterial.jwks`. This object is built once in `loadKey()` and never mutates. There is no caching header — the operator sets cache semantics at the reverse proxy if desired.

### `POST /tokens`

```
request
  → express.json middleware
  → validate body.sender (non-empty string)
  → resolve ttl (body.ttl_seconds ?? config.defaultTtlSeconds)
  → validate ttl (finite, positive)
  → clamp ttl (min(ttl, config.maxTtlSeconds))
  → jose.SignJWT({ macp_scopes: body.scopes ?? {} })
      .setProtectedHeader({ alg: signing.alg, kid })   // RS256 (default) or ES256
      .setSubject(body.sender)
      .setIssuer(config.issuer)
      .setAudience(config.audience)
      .setIssuedAt()
      .setExpirationTime(`${ttl}s`)
      .sign(signing.privateKey)
  → { token, sender, expires_in_seconds } response
```

Two validation branches fail fast with `400` before any signing work happens. Once validation passes, `jose.SignJWT` builds the JWS compact serialization entirely in memory. The private key is held as a Node `KeyObject` (via `jose.importJWK` or `jose.generateKeyPair`); it is never exposed outside this module and is never logged.

Clock skew handling is deliberately simple: `iat` is set to the process's current time and `exp` is `iat + ttl`. The verifier is responsible for tolerating skew via `clockTolerance` — the runtime defaults to a small window.

## Key lifecycle

`loadKey()` returns a `SigningMaterial` object that the app holds for its entire lifetime.

```
SigningMaterial {
  privateKey: jose.KeyLike        // signing key, never exposed
  jwks: { keys: [JWK] }           // public JWKS document, served verbatim
  alg: 'RS256' | 'ES256'         // configured signature algorithm; used in the JWT header
  source: 'ephemeral' | 'env'    // diagnostic only — logged on startup
}
```

`loadKey(signingKeyJson, alg)` takes the algorithm from `config.signingAlg` (`MACP_AUTH_SIGNING_ALG`, default `RS256`). `RS256` produces an RSA keypair; `ES256` produces an EC P-256 keypair. The same two paths apply to either algorithm:

### Ephemeral (dev)

When `MACP_AUTH_SIGNING_KEY_JSON` is unset, `loadKey()` calls `jose.generateKeyPair(alg)` at startup. It exports the public half as a JWK, tags it with `kid: 'dev-key-1'` and the configured `alg`, and returns it. The keypair is process-scoped — a restart generates a fresh key, invalidating every outstanding token the previous process signed.

Use this only for local iteration. Any verifier that fetched and cached the prior JWKS will fail every token issued after a restart until the cache expires.

### Pinned (prod)

When `MACP_AUTH_SIGNING_KEY_JSON` is set, `loadKey()` parses it as a JWK, imports the private key, and derives the public JWK by stripping the private component (`d`) and re-importing. Re-importing a JWK without `d` yields a public key, so re-exporting it drops every private field — RSA `p`/`q`/`dp`/`dq`/`qi` or the EC scalar — and the JWKS can never leak private material regardless of what the operator pasted in. The `kid` comes from the JWK itself, falling back to `'key-1'` if absent.

The JWK's key type must match `MACP_AUTH_SIGNING_ALG`: an RSA private JWK (`d`, `p`, `q`, `dp`, `dq`, `qi`) for `RS256`, or an EC P-256 private JWK (`crv: "P-256"`, `x`, `y`, `d`) for `ES256`. A parse failure, type mismatch, or import failure is fatal — `main()` catches the error in `void main().catch(...)` and exits with code 1. This is intentional: a misconfigured key should prevent startup, not silently fall back to ephemeral. An unsupported `MACP_AUTH_SIGNING_ALG` value is likewise rejected at config load.

### Rotation

There is no in-process rotation. The service advertises exactly one key at any given time. To rotate:

1. Generate a new JWK with a new `kid`.
2. Update `MACP_AUTH_SIGNING_KEY_JSON` in the secret store.
3. Restart the service.
4. Wait `MACP_AUTH_JWKS_TTL_SECS` for verifiers to refresh their JWKS caches.
5. In-flight tokens signed by the previous key stop verifying at the end of their own TTL.

Step 4's one-TTL bound assumes a **healthy** JWKS endpoint. On runtime >= 0.5.0, a verifier whose refresh fails serves its last-known keys under a stale-cache grace for up to `TTL + 3600 s`, so a rotated-out key can verify that long on an isolated verifier; a runtime restart is the hard cutoff. See [Operations — Key rotation](operations.md#key-rotation) for the operational procedure and the emergency-rotation checklist that closes this gap.

## Concurrency model

Node.js single-threaded event loop. `jose.SignJWT.sign()` is async — it returns a Promise and releases the event loop while the underlying crypto runs in libuv worker threads. The service does not serialize requests; many mints run in parallel bounded only by libuv's thread pool (default 4).

The in-memory `SigningMaterial` is immutable for the process lifetime, so no locking is needed. There is no shared mutable state.

## Failure modes and responses

| Failure | Response | Recovery |
|---------|----------|----------|
| Malformed JSON body | `400` (express default) | Caller resends valid JSON. |
| Missing `sender` | `400` with `{"error":"sender is required"}` | Caller adds `sender`. |
| Invalid `ttl_seconds` | `400` with `{"error":"ttl_seconds must be a positive number"}` | Caller passes a finite positive number. |
| `jose.SignJWT(...).sign()` throws | `500` (express default) | Unexpected — investigate logs. Usually indicates a key material corruption. |
| Invalid `MACP_AUTH_SIGNING_KEY_JSON` at startup | Process exit code 1 | Fix the JWK in the secret store and restart. |
| Port already in use | Process exit code 1 | Change `PORT` or free the port. |

There are deliberately no fallbacks. If the key is broken, the service exits rather than limping along.

## Observability

Two observables leave the process:

- **Stdout logs.** `index.ts` prints five `[auth-service]` lines on startup (port, issuer/audience, key source, JWKS URL, mint URL) and one line on shutdown. The service does not log per-request — adding an access log is a deployment-time concern handled by the reverse proxy.
- **HTTP status codes.** `GET /healthz` returns 200 always-on; the orchestrator's probe treats the first successful response after start as "ready."

The service does not emit metrics. If you need Prometheus counters (mint count, mint latency, error rate), add a `prom-client` registry in a thin wrapper; the hooks are straightforward because `createApp` is pure.

## Dependency choices

| Dependency | Version | Why |
|------------|---------|-----|
| `express` | `^5.2.1` | Standard Node HTTP framework. Async-first in v5, no need for `express-async-errors`. |
| `jose` | `^5.9.6` | Spec-compliant JOSE (JWS, JWE, JWK, JWKS) with full TypeScript types. **Pinned to v5** for CommonJS compatibility with ts-jest. v6+ is ESM-only. |
| `typescript` | `^5.6.3` | Matches the rest of the MACP monorepo. `strict` mode plus `noUnusedLocals` / `noUnusedParameters` / `noImplicitOverride`. |
| `@types/node` | `^20.x` | Matches `engines.node >= 20`. |
| `jest` + `ts-jest` + `supertest` | current stable | HTTP integration tests against the real Express surface with real RSA keys. |

`jose` is the only non-framework dependency. No custom crypto, no `jsonwebtoken`, no `node-jose`. This narrows the trusted-code surface for a service whose entire job is signing tokens.

## What this architecture rules out

A few capabilities are intentionally absent and should not be added without first questioning the design goals above.

- **User accounts / password auth.** The auth-service does not know who the caller is. Caller identification is a reverse-proxy concern.
- **Token revocation.** The service has no store to revoke from. Short TTLs plus key rotation are the only revocation primitives.
- **Audit logging.** The service does not log mints. An upstream API gateway (or the caller — typically the [control-plane](https://github.com/multiagentcoordinationprotocol/macp-control-plane) or a custom orchestrator built on the [TypeScript SDK](https://github.com/multiagentcoordinationprotocol/macp-sdk-typescript) or [Python SDK](https://github.com/multiagentcoordinationprotocol/macp-sdk-python)) is responsible for audit.
- **Multiple active keys.** `SigningMaterial.jwks` is always a single-entry array. Supporting N active keys would require a key manager, a selector, and a cache-invalidation strategy — all of which belong in a key management service, not here.

If any of these is required for your deployment, the right move is to put a dedicated service in front of this one and keep this one minimal.
