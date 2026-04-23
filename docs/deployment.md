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
| `MACP_AUTH_SIGNING_KEY_JSON` | *(ephemeral)* | **yes in prod** | RSA private JWK as a JSON string. See below for generation. |

Environment variables are read by `src/config.ts` via `loadConfigFromEnv()`. No other file reads `process.env`. This means a single command with the right env applies globally; there are no per-request overrides.

## Signing key generation

Generate an RSA keypair as a JWK once, store the private JWK in your secret manager, and inject it at process start.

```bash
node -e "const {generateKeyPair,exportJWK}=require('jose'); \
  (async()=>{const {privateKey}=await generateKeyPair('RS256',{extractable:true}); \
  const jwk=await exportJWK(privateKey); \
  jwk.kid='prod-key-' + new Date().toISOString().slice(0,10); \
  jwk.alg='RS256'; jwk.use='sig'; \
  console.log(JSON.stringify(jwk))})()"
```

The `kid` should be unique per key version. Embedding the generation date (`prod-key-2026-04-22`) is a reasonable convention — it makes rotation history visible at a glance in logs and verifier caches.

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

See the [Operations Runbook](operations.md#key-rotation) for the step-by-step procedure including verification and rollback.

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

CI publishes to `ghcr.io/multiagentcoordinationprotocol/auth-service`. PR builds are tagged `pr-<n>`. Merges to `main` are tagged `latest` and `sha-<7hex>`. See `.github/workflows/docker.yml` for the exact tagging strategy.

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
  ghcr.io/multiagentcoordinationprotocol/auth-service:latest
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
          image: ghcr.io/multiagentcoordinationprotocol/auth-service:sha-abc1234
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
```

The runtime fetches the JWKS on first use and caches it for `MACP_AUTH_JWKS_TTL_SECS`. Any token presented to the runtime is rejected unless:

- The signature verifies against a key in the cached JWKS.
- `iss` matches `MACP_AUTH_ISSUER`.
- `aud` matches `MACP_AUTH_AUDIENCE`.
- `exp` is in the future (within tolerable clock skew).

See the [runtime Getting Started guide](https://github.com/multiagentcoordinationprotocol/runtime/blob/main/docs/getting-started.md#jwt-mode) for the full JWT configuration reference on the runtime side.

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
        proxy_pass http://127.0.0.1:3200;
        add_header Cache-Control "public, max-age=60";
    }

    location /tokens {
        # Replace with your actual caller-auth mechanism
        auth_request /internal-auth-check;
        proxy_pass http://127.0.0.1:3200;
    }

    location /healthz { proxy_pass http://127.0.0.1:3200; }
}
```

The `Cache-Control` on the JWKS is optional but reduces runtime chatter once the cache warms.

## CI/CD

Two GitHub Actions workflows ship with the repo.

| Workflow | Trigger | Purpose |
|----------|---------|---------|
| `ci.yml` | PR + push to `main` | Lint, typecheck, build, test |
| `docker.yml` | PR + push to `main` | Build and publish container image to GHCR |
| `notify-website.yml` | push to `main` with docs changes | Notify the docs website to sync |

CI runs `npm ci && npm run lint && npm run typecheck && npm run build && npm test` against Node 20. The Docker workflow tags images `pr-<n>` for PR builds and `latest` + `sha-<7hex>` for main.

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
