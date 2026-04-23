# API Reference

This is the reference for every HTTP endpoint exposed by the auth-service. The default base URL is `http://127.0.0.1:3200`, configurable via the `PORT` environment variable.

For protocol-level transport semantics and the JWT claim model, see the [protocol transports documentation](https://www.multiagentcoordinationprotocol.io/docs/transports) and [protocol security documentation](https://www.multiagentcoordinationprotocol.io/docs/security).

## Endpoints at a glance

| Method | Path | Purpose | Auth |
|--------|------|---------|------|
| `GET` | `/healthz` | Liveness probe | none |
| `GET` | `/.well-known/jwks.json` | Public JWKS for JWT verification | none |
| `POST` | `/tokens` | Mint a short-lived RS256 JWT | **none by default** (see [Deployment](deployment.md)) |

All responses are `application/json`. All requests that carry a body must use `content-type: application/json`.

## Liveness

### `GET /healthz`

Liveness probe. Returns `200 OK` as long as the process is accepting connections. There is no readiness signal distinct from liveness: the service is stateless and ready as soon as `loadKey` completes during startup.

**Response**

```json
{ "ok": true }
```

**Example**

```bash
curl -sS http://localhost:3200/healthz
```

Use this endpoint for Kubernetes `livenessProbe`, Docker `HEALTHCHECK`, and load-balancer health checks. The Dockerfile ships with a built-in `HEALTHCHECK` wired to this path.

## Key distribution

### `GET /.well-known/jwks.json`

Returns the public JWKS document that verifiers (typically the MACP runtime) fetch to validate token signatures. Private material is never exposed here.

**Response**

```json
{
  "keys": [
    {
      "kty": "RSA",
      "n": "…base64url modulus…",
      "e": "AQAB",
      "kid": "dev-key-1",
      "alg": "RS256",
      "use": "sig"
    }
  ]
}
```

**Response fields (per key entry)**

| Field | Type | Description |
|-------|------|-------------|
| `kty` | string | Key type. Always `RSA` for this service. |
| `n` | string | base64url-encoded RSA modulus |
| `e` | string | base64url-encoded RSA exponent (typically `AQAB`) |
| `kid` | string | Key identifier. `dev-key-1` for ephemeral keys; whatever was set in the JWK for pinned keys. |
| `alg` | string | Signature algorithm. Always `RS256`. |
| `use` | string | Key usage. Always `sig`. |

The service publishes exactly one key at any given time. Rotating keys means replacing the JWK, redeploying, and waiting `MACP_AUTH_JWKS_TTL_SECS` for verifiers to refresh. See [Operations — Key rotation](operations.md#key-rotation).

**Example**

```bash
curl -sS http://localhost:3200/.well-known/jwks.json | jq .
```

## Token minting

### `POST /tokens`

Mints an RS256-signed JWT for the requested `sender` with the supplied scopes and TTL. The returned token can be presented as a gRPC `Authorization: Bearer <token>` header to the MACP runtime.

**Request body**

```json
{
  "sender": "agent://risk",
  "scopes": {
    "can_start_sessions": true,
    "is_observer": false,
    "allowed_modes": ["macp.mode.decision.v1"],
    "max_open_sessions": 1,
    "can_manage_mode_registry": false
  },
  "ttl_seconds": 3600
}
```

**Request fields**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `sender` | string | Yes | The agent identity. Becomes the JWT `sub` claim and the authenticated sender the runtime associates with incoming frames. Must be a non-empty string. |
| `scopes` | object | No | Capability flags, serialized verbatim under `macp_scopes`. Defaults to `{}` (permissive in the runtime's current interpretation — see scopes schema below). |
| `ttl_seconds` | number | No | Requested token lifetime in seconds. Must be positive and finite. Clamped to `MACP_AUTH_MAX_TTL_SECONDS`. Defaults to `MACP_AUTH_DEFAULT_TTL_SECONDS` when omitted. |

**Scopes schema** (all fields optional)

| Field | Type | Runtime meaning |
|-------|------|-----------------|
| `can_start_sessions` | boolean | May submit `SessionStart` envelopes. |
| `can_manage_mode_registry` | boolean | May register / unregister / promote extension modes. |
| `is_observer` | boolean | May passive-subscribe to sessions the caller is not a declared participant of. |
| `allowed_modes` | string[] | If non-empty, restricts the set of modes the sender may use. Empty or omitted = all modes allowed. |
| `max_open_sessions` | number | Upper bound on concurrent open sessions the sender can initiate. |

The auth-service does not inspect these fields beyond serializing them — enforcement is entirely on the runtime side. You can pass additional keys and the runtime will surface them via the identity's scopes map, but they will be ignored by current runtime capability checks.

**Response**

```json
{
  "token": "eyJhbGciOiJSUzI1NiIsImtpZCI6ImRldi1rZXktMSJ9.eyJtYWNwX3Njb3BlcyI6e30sImlhdCI6...",
  "sender": "agent://risk",
  "expires_in_seconds": 3600
}
```

**Response fields**

| Field | Type | Description |
|-------|------|-------------|
| `token` | string | The compact serialized JWT. Present as `Authorization: Bearer <token>` to the runtime. |
| `sender` | string | Echo of the request's `sender`. Also present as the JWT's `sub` claim. |
| `expires_in_seconds` | number | The effective TTL after clamping against `MACP_AUTH_MAX_TTL_SECONDS`. May be less than the requested `ttl_seconds`. |

**JWT claim structure**

| Claim | Source | Description |
|-------|--------|-------------|
| `iss` | `MACP_AUTH_ISSUER` | Token issuer. Must match the runtime's configured issuer. |
| `aud` | `MACP_AUTH_AUDIENCE` | Token audience. Must match the runtime's configured audience. |
| `sub` | request `sender` | Authenticated agent identity. |
| `iat` | now | Issued-at (seconds since epoch). |
| `exp` | `iat + effective_ttl` | Expiration (seconds since epoch). |
| `macp_scopes` | request `scopes` | Capability flags, serialized verbatim. |

The JWT header always carries `alg: RS256` and `kid` matching the key advertised in the JWKS.

**Example**

```bash
curl -sS -X POST http://localhost:3200/tokens \
  -H 'content-type: application/json' \
  -d '{
    "sender": "agent://risk",
    "scopes": { "can_start_sessions": true, "allowed_modes": ["macp.mode.decision.v1"] },
    "ttl_seconds": 600
  }'
```

## Errors

The service returns plain JSON errors with an `error` field. Only the validation errors below are emitted by the service itself; signature-verification and claim-validation errors surface at the **verifier** (the runtime), not here.

### Error table

| Status | Body | Cause |
|--------|------|-------|
| `400` | `{"error":"sender is required"}` | Body missing, not JSON, or `sender` absent / empty / not a string. |
| `400` | `{"error":"ttl_seconds must be a positive number"}` | `ttl_seconds` is `0`, negative, `NaN`, `Infinity`, or non-numeric. |
| `404` | (express default) | Unknown path. |
| `500` | (express default) | Should not occur in normal operation. Indicates an unexpected exception during signing; check server logs. |

### Verifier-side errors

The following are raised by `jose.jwtVerify` (or an equivalent verifier) at the runtime, not by this service. They are listed here as reference because operators often see them while debugging an integration.

| Error name | Cause | Resolution |
|------------|-------|------------|
| `JWSSignatureVerificationFailed` | Key rotation not yet reflected in verifier's JWKS cache, or token signed by a different key entirely. | Wait `MACP_AUTH_JWKS_TTL_SECS`, or restart the verifier; confirm `kid` in token matches a JWKS entry. |
| `JWTClaimValidationFailed: iss` | Issuer mismatch between minter and verifier. | Align `MACP_AUTH_ISSUER`. |
| `JWTClaimValidationFailed: aud` | Audience mismatch. | Align `MACP_AUTH_AUDIENCE`. |
| `JWTExpired` | Token `exp` has passed, or large clock skew between minter and verifier. | Mint a fresh token; verify NTP sync. |
| `JWTClaimValidationFailed: nbf` | `nbf` in the future — only possible if a custom minter adds `nbf`; this service does not. | N/A for this service. |

## Rate limiting

The service does **not** rate-limit `POST /tokens`. Deployments that need per-caller limits should add them in the reverse proxy (nginx `limit_req`, Envoy local rate limit, API gateway rules, etc.). See [Operations — Abuse mitigation](operations.md#abuse-mitigation).

## Request size limits

`express.json()` accepts payloads up to the default 100 KiB. The service does not override this. A well-formed mint request is under 1 KiB; payloads anywhere near the limit indicate misuse.

## Idempotency

Mint requests are not idempotent. Every call generates a new JWT with fresh `iat` / `exp` claims even when the request body is identical. Callers that need idempotency (e.g. an outer control-plane that retries) should cache the minted token keyed by request parameters and replay within the returned `expires_in_seconds` window.
