# Deployment Guide

This guide covers everything you need to run the auth-service in production: the production checklist, environment variables, secret handling, container deployment, TLS termination, and verifier wiring. For protocol-level deployment topologies, see the [protocol deployment](https://www.multiagentcoordinationprotocol.io/docs/deployment) and [protocol security](https://www.multiagentcoordinationprotocol.io/docs/security) documentation.

## Production checklist

Before exposing the auth-service to production traffic, confirm these five items.

1. **Pinned signing key.** Set `MACP_AUTH_SIGNING_KEY_JSON` from your secret store. The service generates an ephemeral keypair when unset, which is fatal in any shared deployment — every restart invalidates every issued token until the verifier's JWKS cache refreshes.

2. **Issuer and audience alignment.** `MACP_AUTH_ISSUER` and `MACP_AUTH_AUDIENCE` on the auth-service must match the runtime's `MACP_AUTH_ISSUER` and `MACP_AUTH_AUDIENCE`. A mismatch is the single most common cause of `JWTClaimValidationFailed` errors in integrations.

3. **Front it with auth.** The `POST /tokens` endpoint has no client authentication. Put the service behind mTLS, an authenticating reverse proxy, or a shared-secret `Authorization` check before anything outside your trust boundary can reach it.

4. **TLS termination.** The service speaks plain HTTP. Run it behind a TLS-terminating proxy (nginx, Envoy, cloud load balancer). Tokens on the wire must be TLS-protected; the JWKS itself is public but should still be served over HTTPS so verifiers can trust the key distribution channel.

5. **Bounded TTLs.** `MACP_AUTH_MAX_TTL_SECONDS` is your revocation horizon — a stolen token is valid until it expires. Keep the max TTL short (hours, not days) unless you have a compensating control.

## Environment variables

| Variable | Default | Required? | Description |
|----------|---------|-----------|-------------|
| `PORT` | `3200` | no | HTTP listen port |
| `MACP_AUTH_ISSUER` | `macp-auth-service` | no | JWT `iss` claim. Must match the verifier's expected issuer. |
| `MACP_AUTH_AUDIENCE` | `macp-runtime` | no | JWT `aud` claim. Must match the verifier's expected audience. |
| `MACP_AUTH_MAX_TTL_SECONDS` | `3600` | no | Upper bound on minted token lifetime. Clients requesting more are clamped down. |
| `MACP_AUTH_DEFAULT_TTL_SECONDS` | `300` | no | TTL applied when the request omits `ttl_seconds`. |
| `MACP_AUTH_SIGNING_ALG` | `RS256` | no | Signature algorithm: `RS256` (RSA) or `ES256` (EC P-256). The runtime accepts either. An unsupported value fails startup. |
| `MACP_AUTH_SIGNING_KEY_JSON` | *(ephemeral)* | **yes in prod** | Private JWK as a JSON string, matching `MACP_AUTH_SIGNING_ALG` (RSA for `RS256`, EC P-256 for `ES256`). See below for generation. |

Environment variables are read by `src/config.ts` via `loadConfigFromEnv()`. No other file reads `process.env`. This means a single command with the right env applies globally; there are no per-request overrides.

## Signing key generation

Generate a keypair as a JWK once, store the private JWK in your secret manager, and inject it at process start. The snippet below produces an RSA key for the default `RS256`; for `MACP_AUTH_SIGNING_ALG=ES256`, swap both `'RS256'` literals for `'ES256'` and the output is an EC P-256 JWK (`kty: "EC"`).

```bash
node -e "const {generateKeyPair,exportJWK}=require('jose'); \
  (async()=>{const {privateKey}=await generateKeyPair('RS256',{extractable:true}); \
  const jwk=await exportJWK(privateKey); \
  jwk.kid='prod-key-' + new Date().toISOString().slice(0,10); \
  jwk.alg='RS256'; jwk.use='sig'; \
  console.log(JSON.stringify(jwk))})()"
```

The JWK's key type must match `MACP_AUTH_SIGNING_ALG`. The `kid` should be unique per key version. Embedding the generation date (`prod-key-2026-04-22`) is a reasonable convention — it makes rotation history visible at a glance in logs and verifier caches.

Store the output in your secret manager as a single string. Do **not** commit the JWK; do **not** log it; do **not** pipe it through a console that retains scrollback on a shared host.

## Key rotation

Key rotation is a deploy-and-wait procedure. There is no in-process rotation; there is no multi-key JWKS.

```
1. Generate a new JWK with a new kid.
2. Store the new JWK in the secret manager.
3. Roll the deployment so new replicas pick up the new MACP_AUTH_SIGNING_KEY_JSON.
4. Wait MACP_AUTH_JWKS_TTL_SECS for all verifiers' JWKS caches to refresh.
5. Existing tokens signed by the old key remain valid until their own exp.
```

Convergence bound (runtime ≥ 0.5.0): with a **healthy** JWKS endpoint, every verifier picks up the new key within one `MACP_AUTH_JWKS_TTL_SECS` window (step 4). If the JWKS endpoint is **unreachable** when a verifier tries to refresh, that verifier keeps serving its last-known key set for up to `TTL + 3600 s` (stale-cache grace) — so a rotated-out key can still verify that long. A runtime restart clears the in-memory cache and is the hard cutoff. This matters most for emergency rotation — see the [Operations Runbook](operations.md#key-rotation) for the step-by-step procedure including JWKS-reachability verification, the outage caveat, and rollback.

## Secret handling

The private JWK is the most sensitive artifact in the MACP security model. A leaked key lets an attacker mint tokens for any `sender` with any scopes until the key is rotated out.

- **Kubernetes.** Store as a `Secret`, mount as an env var via `envFrom.secretKeyRef`. Do not use `configMap`.
- **AWS.** Store in Secrets Manager or Parameter Store (SecureString), inject via IAM-scoped retrieval at container start.
- **Vault.** Store under a dedicated path with short-TTL dynamic leases; restart the service when the lease renews.
- **Docker Compose / local.** Use `.env` files excluded from version control. Never commit a `.env` with `MACP_AUTH_SIGNING_KEY_JSON` set.

Confirm the secret does not appear in container manifests, CI artifacts, or log output. The service never logs tokens or keys; audit that your infra around it matches that discipline.

## Docker

The provided Dockerfile is multi-stage and ships a minimal runtime image.

```bash
docker build -t macp-auth-service:local .
docker run --rm -p 3200:3200 macp-auth-service:local
curl http://localhost:3200/healthz
```

### Image details

- **Base:** `node:20-alpine` (builder, deps, runtime stages).
- **User:** non-root `appuser:appgroup`.
- **Final contents:** `dist/` (compiled TypeScript) + `node_modules` (production only) + `package.json`.
- **Entrypoint:** `node dist/index.js`.
- **Healthcheck:** `wget -qO- http://localhost:3200/healthz` with a 10 s interval.
- **Exposed port:** `3200`.
- **Size:** ~200 MB uncompressed.

### Published images

CI publishes to `ghcr.io/multiagentcoordinationprotocol/macp-auth-service`. Every image is booted and smoke-tested (`scripts/smoke.js`) before it is pushed. PR builds are `linux/amd64` only and tagged `pr-<n>`; merges to `main` and `v*` tags are multi-arch (`linux/amd64` + `linux/arm64`) tagged `latest` and `sha-<7hex>`. See `.github/workflows/docker.yml` for the exact tagging strategy.

### Recommended runtime configuration

```bash
docker run -d \
  --name macp-auth \
  --restart unless-stopped \
  --read-only --tmpfs /tmp \
  -e MACP_AUTH_ISSUER=auth.example.com \
  -e MACP_AUTH_AUDIENCE=macp-runtime \
  -e MACP_AUTH_MAX_TTL_SECONDS=3600 \
  -e MACP_AUTH_SIGNING_KEY_JSON="$(cat /run/secrets/signing-key.json)" \
  -p 127.0.0.1:3200:3200 \
  ghcr.io/multiagentcoordinationprotocol/macp-auth-service:latest
```

The `--read-only` flag is safe because the service writes nothing to disk. Binding to `127.0.0.1` ensures only local callers (or a reverse proxy on the same host) can reach the mint endpoint.

## Kubernetes

A minimal `Deployment` + `Service` manifest:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: macp-auth
spec:
  replicas: 2
  selector:
    matchLabels: { app: macp-auth }
  template:
    metadata:
      labels: { app: macp-auth }
    spec:
      containers:
        - name: auth
          image: ghcr.io/multiagentcoordinationprotocol/macp-auth-service:sha-abc1234
          ports:
            - containerPort: 3200
          env:
            - name: MACP_AUTH_ISSUER
              value: auth.example.com
            - name: MACP_AUTH_AUDIENCE
              value: macp-runtime
            - { name: MACP_AUTH_SIGNING_KEY_JSON, valueFrom: { secretKeyRef: { name: macp-auth-signing, key: jwk } } }
          readinessProbe:
            httpGet: { path: /healthz, port: 3200 }
          livenessProbe:
            httpGet: { path: /healthz, port: 3200 }
          resources:
            requests: { cpu: 50m, memory: 128Mi }
            limits:   { cpu: 500m, memory: 256Mi }
          securityContext:
            readOnlyRootFilesystem: true
            runAsNonRoot: true
            allowPrivilegeEscalation: false
            capabilities: { drop: ["ALL"] }
---
apiVersion: v1
kind: Service
metadata:
  name: macp-auth
spec:
  selector: { app: macp-auth }
  ports:
    - port: 3200
      targetPort: 3200
```

Because the service is stateless, horizontal scaling is trivial — any replica can handle any mint. All replicas in a deployment must share the same `MACP_AUTH_SIGNING_KEY_JSON`; mixing keys would advertise different JWKS to different verifiers.

## Verifier (runtime) wiring

Configure the Rust runtime to trust tokens issued by this service:

```bash
export MACP_AUTH_ISSUER=auth.example.com                       # matches auth-service
export MACP_AUTH_AUDIENCE=macp-runtime                         # matches auth-service
export MACP_AUTH_JWKS_URL=https://auth.example.com/.well-known/jwks.json
export MACP_AUTH_JWKS_TTL_SECS=300                             # cache refresh interval
export MACP_AUTH_JWT_ALGS=RS256,ES256                          # runtime ≥ 0.5.0 default allowlist
```

`MACP_AUTH_JWT_ALGS` is the runtime's signature-algorithm allowlist. Its default (`RS256,ES256`) already covers both algorithms this service can mint, so you normally leave it unset; HS256 is refused unless you add it here explicitly (and this service cannot mint HS256 regardless). The runtime fetches the JWKS on first use and caches it for `MACP_AUTH_JWKS_TTL_SECS`. Any token presented to the runtime is rejected unless:

- The signature verifies against a key in the cached JWKS.
- The header `alg` is in the runtime's `MACP_AUTH_JWT_ALGS` allowlist.
- `iss` matches `MACP_AUTH_ISSUER`.
- `aud` matches `MACP_AUTH_AUDIENCE`.
- `exp` is in the future (within tolerable clock skew).

For an air-gapped runtime that cannot reach this service over HTTP, the runtime also accepts the JWKS inline via `MACP_AUTH_JWKS_JSON` instead of `MACP_AUTH_JWKS_URL` — paste the exact body of `GET /.well-known/jwks.json`. This works precisely because our JWKS is stable when the signing key is pinned; you must re-push it on every key rotation, since there is no fetch to pick up the change.

See the [runtime Getting Started guide](https://github.com/multiagentcoordinationprotocol/macp-runtime/blob/main/docs/getting-started.md#jwt-mode) for the full JWT configuration reference on the runtime side.

## TLS termination

The service does not terminate TLS itself. Run it behind:

- **nginx / Caddy / Traefik** — standard ingress proxy with a Let's Encrypt cert.
- **Envoy / Istio** — mesh-native TLS between the caller and the auth-service.
- **Cloud load balancers** — AWS ALB, GCP HTTPS LB, Azure Application Gateway.

A minimal nginx snippet:

```nginx
server {
    listen 443 ssl http2;
    server_name auth.example.com;
    ssl_certificate     /etc/letsencrypt/live/auth.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/auth.example.com/privkey.pem;

    location = /.well-known/jwks.json {
        # Keep this path fast and unauthenticated: never gate it behind auth_request
        # or an interactive challenge — the runtime fetches it non-interactively.
        proxy_pass http://127.0.0.1:3200;
        add_header Cache-Control "public, max-age=60";
    }

    location /tokens {
        # Replace with your actual caller-auth mechanism.
        # Note: auth_request here is fine — it fronts the *mint* endpoint, not the JWKS.
        auth_request /internal-auth-check;
        proxy_pass http://127.0.0.1:3200;
    }

    location /healthz { proxy_pass http://127.0.0.1:3200; }
}
```

The `Cache-Control` on the JWKS is optional but reduces runtime chatter once the cache warms.

**JWKS latency budget (runtime ≥ 0.5.0).** The runtime aborts a JWKS fetch at **3 s to connect / 5 s total**. The auth-service itself answers in microseconds (the JWKS object is precomputed at startup), so the whole budget is spent in whatever sits in front of it: the `/.well-known/jwks.json` path must respond well under 5 s end-to-end, including TLS handshake and any cold DNS. Keep this path off `auth_request` and off any interactive challenge — a fetch that stalls past 5 s makes the runtime fall back to its stale cache (or fail auth entirely on a cold verifier), which is exactly the failure the grace window is meant to paper over, not a state you want to enter routinely.

## CI/CD

Three GitHub Actions workflows ship with the repo.

| Workflow | Trigger | Purpose |
|----------|---------|---------|
| `ci.yml` | PR + push to `main` | Lint, typecheck, test, build + smoke test, dependency review |
| `docker.yml` | PR + push to `main` / tags | Build the container image, smoke-test it, publish to GHCR |
| `notify-website.yml` | push to `main` with docs changes | Notify the docs website to sync |

`ci.yml` runs lint and typecheck, then the test suite on a Node 20 + 22 matrix (Node 20 is the `engines` floor). Coverage floors are enforced by `coverageThreshold` in `jest.config.js`, so a coverage regression fails the build. The build job compiles the service, boots `dist/index.js`, and runs `scripts/smoke.js` against it — a black-box check that mints a token and verifies its signature against the served JWKS. PRs additionally get a dependency review that fails on newly introduced high-severity vulnerable dependencies.

`docker.yml` builds the image into the local daemon first, boots it, runs `scripts/smoke.js` against the container, and waits for the Dockerfile `HEALTHCHECK` to report healthy — only then does it push, so a broken image can never reach the registry. PR builds are `linux/amd64` only and tagged `pr-<n>` (PRs from forks build but do not push — their token cannot write to GHCR). Pushes to `main` and version tags build the multi-arch manifest (`linux/amd64` + `linux/arm64` via pinned QEMU) tagged `latest` + `sha-<7hex>`, plus semver tags on `v*` releases.

## Resource sizing

A single replica comfortably handles hundreds of mints per second on a modest VM. RSA signing is the dominant cost and runs on libuv worker threads (default 4). Under sustained heavy load, raise `UV_THREADPOOL_SIZE` or scale horizontally — additional replicas cost effectively nothing since there is no shared state.

Memory is dominated by Node's baseline plus the single keypair. Steady-state is well under 128 MiB. CPU is bursty — idle between mints, ~10 ms on a modern core per RS256 signature.

## Rolling upgrades

Because the service is stateless and every replica advertises the same JWK (they share `MACP_AUTH_SIGNING_KEY_JSON`), rolling upgrades have no cross-replica coordination requirement. Rolling from version N to N+1:

1. Update the image tag in the deployment manifest.
2. Kubernetes / Nomad / ECS performs a standard rolling replacement.
3. Each replica's `/healthz` returns 200 as soon as `loadKey()` completes — typically under a second.
4. Existing tokens continue to verify because the JWK has not changed.

The one caveat: if the upgrade also rotates the key, follow the [rotation runbook](operations.md#key-rotation) instead.
