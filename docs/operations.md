# Operations Runbook

This is the runbook for operators running the auth-service in production. It covers routine operations (key rotation, restarts), diagnostics (log interpretation, common failures), and incident response (suspected key compromise, mint endpoint abuse).

For first-time setup and the production checklist, see the [Deployment Guide](deployment.md). For protocol-level security considerations, see the [protocol security documentation](https://www.multiagentcoordinationprotocol.io/docs/security).

## Startup logs

The service prints five lines on startup. Use these as a fingerprint for correct configuration.

```
[auth-service] listening on port 3200
[auth-service] issuer=macp-auth-service audience=macp-runtime
[auth-service] key source: env
[auth-service] JWKS: http://localhost:3200/.well-known/jwks.json
[auth-service] Mint: POST http://localhost:3200/tokens
```

Key things to check:

| Field | Expect | If wrong |
|-------|--------|----------|
| `port` | Matches your `PORT` env or 3200 default | Container port mapping broken; fix the orchestrator manifest. |
| `issuer` | Matches the runtime's `MACP_AUTH_ISSUER` | Verifiers will reject every token with `JWTClaimValidationFailed: iss`. |
| `audience` | Matches the runtime's `MACP_AUTH_AUDIENCE` | Verifiers will reject every token with `JWTClaimValidationFailed: aud`. |
| `key source` | `env` in production | **`ephemeral` in production is an incident.** See below. |

### `key source: ephemeral` in production

If you see `key source: ephemeral` in a production replica, treat it as a P1.

**Impact.** Every issued token is signed by a process-local keypair that will not survive a restart. Verifiers cache the current JWKS; when the pod restarts (for any reason) every token issued by the new process will fail signature verification until the verifier's cache expires and re-fetches.

**Cause.** `MACP_AUTH_SIGNING_KEY_JSON` is unset in the container's environment.

**Remediation.**
1. Confirm the secret is present in your secret store.
2. Confirm the deployment manifest references the secret correctly (`envFrom` / `valueFrom.secretKeyRef`).
3. Roll the deployment. On restart the log should read `key source: env`.

## Key rotation

Rotation is the primary remediation for a suspected key compromise and a routine hygiene operation otherwise. Plan for rotations to be seamless to callers — tokens in flight keep working, new tokens use the new key.

### Routine rotation

```
Step 1. Generate a new JWK.
  node -e "const {generateKeyPair,exportJWK}=require('jose');
    (async()=>{const {privateKey}=await generateKeyPair('RS256',{extractable:true});
    const jwk=await exportJWK(privateKey);
    jwk.kid='prod-key-' + new Date().toISOString().slice(0,10);
    jwk.alg='RS256'; jwk.use='sig';
    console.log(JSON.stringify(jwk))})()"

Step 2. Store the new JWK in the secret manager.
  - Do not delete the previous key yet.
  - Keep the previous key available for rollback until step 6 completes.

Step 3. Roll the deployment.
  - Kubernetes: kubectl rollout restart deployment/macp-auth
  - Docker Compose: docker compose up -d --force-recreate macp-auth
  - Verify: every replica logs `key source: env` and the new kid.

Step 4. Verify the new JWKS is served.
  curl -sS https://auth.example.com/.well-known/jwks.json | jq .keys[0].kid
  # Should print the new kid.

Step 5. Wait MACP_AUTH_JWKS_TTL_SECS.
  - Verifiers refresh their cache on this interval.
  - During this window, new tokens (signed with new key) may fail verification
    on verifiers whose cache still holds the old JWKS. Existing tokens
    (signed with old key) also fail on verifiers that have already refreshed.
  - This window is the only observable disruption; keep it short
    (MACP_AUTH_JWKS_TTL_SECS=60 for fast rotations, 300 for routine).

Step 6. Retire the old key.
  - Delete the previous JWK from the secret manager.
  - Optionally audit access to confirm no replica is still holding it.
```

### Emergency rotation (suspected compromise)

Rotate immediately. Do not wait for a maintenance window. The process is the same as routine rotation but with these additions:

- **Set `MACP_AUTH_JWKS_TTL_SECS=30` on verifiers before rotating** so the disruption window shrinks from minutes to seconds. Restart verifiers to apply.
- **Shorten `MACP_AUTH_MAX_TTL_SECONDS` temporarily** to reduce the life of any outstanding tokens signed by the compromised key. Every token issued by the compromised key remains valid until its own `exp`.
- **Audit the mint log.** The auth-service itself does not log mints, so you need your reverse-proxy access log, API gateway log, or caller-side audit trail. Reconstruct which `sender` identities were minted during the exposure window.
- **Notify downstream operators** that tokens issued before the rotation timestamp should be treated as suspect for the remainder of their TTL.

### Rollback

If the new key is broken (rare — typically a malformed JWK prevents startup entirely), revert the secret to the previous JWK and roll the deployment again. Because the old key's JWKS may still be in verifier caches, rollback usually completes with zero verifier-observable disruption.

## Restart procedure

Restarts are low-risk when the signing key is pinned. The startup sequence is:

1. `loadConfigFromEnv()` parses env.
2. `loadKey()` imports the JWK and derives the public JWKS.
3. `createApp(config, signing)` builds the Express app.
4. `app.listen(config.port)` binds the socket.
5. First `/healthz` returns 200.

Total elapsed time is typically under 500 ms. `readinessProbe` traffic should succeed on the first attempt after the container starts.

### Graceful shutdown

On `SIGTERM` or `SIGINT`, `index.ts` calls `server.close()`, which stops accepting new connections and waits for in-flight requests to complete. If shutdown takes longer than 10 seconds (unlikely — signing is fast), a fallback `setTimeout` forces exit code 1.

Kubernetes sends `SIGTERM` during a pod termination. The service handles it cleanly; no `preStop` lifecycle hook is required.

## Common failures

### Callers receive `ECONNREFUSED` from `/tokens`

Check:
- Container is running: `docker ps` / `kubectl get pods`.
- Port binding: the container must expose `PORT` and the orchestrator must route it.
- Reverse proxy config: if the proxy's upstream points to a stale IP, connections fail even though the container is up.

### Callers receive `400 sender is required` unexpectedly

Check:
- `content-type: application/json` is set on the request. Without it, `express.json()` does not parse the body and `req.body` is `undefined`.
- Body is valid JSON. Malformed bodies are rejected by the express json middleware before the handler runs.

### Verifier reports `JWSSignatureVerificationFailed` after a rotation

Normal during the `MACP_AUTH_JWKS_TTL_SECS` window immediately after rotation. If it persists:
- Confirm the new JWKS is served: `curl https://auth/.well-known/jwks.json`.
- Confirm the verifier is fetching it: check verifier logs for JWKS fetch activity.
- Restart the verifier to force a cache refresh.

### Verifier reports `JWTClaimValidationFailed: iss` or `aud`

The auth-service and the runtime disagree on the issuer/audience. Audit both sides:

```bash
# Auth-service
kubectl exec deploy/macp-auth -- printenv | grep MACP_AUTH
# Runtime
kubectl exec deploy/macp-runtime -- printenv | grep MACP_AUTH_ISSUER MACP_AUTH_AUDIENCE
```

Any drift between the two is the bug. These values should be set from the same source of truth (shared config map or centralized env source).

### Tokens expire faster than expected

Check:
- `MACP_AUTH_MAX_TTL_SECONDS` is not clamping harder than you expect. The returned `expires_in_seconds` in the mint response is authoritative.
- Clock skew between the auth-service host and the verifier host. Large skew (>30 s) makes tokens appear expired to the verifier. Verify NTP sync on both.

### Cannot start: "Invalid key: …" at boot

`MACP_AUTH_SIGNING_KEY_JSON` is malformed. Common causes:
- Shell quoting stripped the quotes inside the JSON. Quote the value correctly or use a file-based secret mount.
- The JWK is public-only (missing `d`, `p`, `q`, etc.). The service requires a **private** JWK.
- The JWK is for a non-RSA algorithm. The service only supports RS256.

Regenerate the JWK using the command in the [Deployment Guide](deployment.md#signing-key-generation) and re-inject.

## Abuse mitigation

`POST /tokens` has no rate limit, no caller authentication by default, and no audit log. If the endpoint is reachable beyond a trusted perimeter, assume abuse is possible.

Recommended controls, in order of strength:

1. **Network isolation.** Bind to `127.0.0.1` and front with a local reverse proxy; or deploy in a private subnet with no public ingress. This is the default assumption.
2. **Reverse-proxy rate limiting.** `nginx limit_req`, Envoy local rate limit filter, or your API gateway's per-source quotas. Cap at what your legitimate callers need.
3. **Caller authentication at the proxy.** mTLS, a shared-secret `Authorization` header check, or upstream OAuth. The auth-service does not perform this check itself — always put it in the proxy.
4. **Audit logging at the proxy.** The service does not log mints. The proxy should log `{ timestamp, caller_identity, sender, scopes, ttl }` for every 2xx response. Treat these logs as security-sensitive (they reveal which identities are active).
5. **Short TTLs.** `MACP_AUTH_MAX_TTL_SECONDS` is the ceiling on damage from a single abused mint. Tune down aggressively — legitimate callers can always re-mint.

## Monitoring signals

The service does not emit metrics. Monitor it via external signals:

| Signal | Source | What it tells you |
|--------|--------|-------------------|
| `/healthz` 2xx rate | Reverse proxy / orchestrator probe | Service availability. |
| `POST /tokens` 4xx rate | Reverse proxy access log | Malformed client requests; investigate if spiking. |
| `POST /tokens` 5xx rate | Reverse proxy access log | Unexpected server errors; should be zero in normal operation. |
| `POST /tokens` p95 latency | Reverse proxy access log | RS256 signing latency. Typically <50 ms. Sustained >250 ms indicates CPU pressure — scale horizontally. |
| Container restarts | Orchestrator | Unexpected restarts mean unexpected key rotations (for ephemeral keys) or env/secret regressions. Alert on non-zero. |
| JWKS fetch rate (runtime-side) | Runtime metrics | Should equal `1 / MACP_AUTH_JWKS_TTL_SECS` per replica. Missing or bursty fetches indicate a verifier-side caching bug. |

If you need in-process metrics, wrap `createApp` to register Prometheus counters before mounting the routes. The hooks are straightforward because `createApp` is pure.

## Incident checklist: suspected key compromise

1. **Rotate the signing key immediately** using the emergency procedure above.
2. **Shorten `MACP_AUTH_MAX_TTL_SECONDS`** to bound outstanding-token exposure.
3. **Reduce `MACP_AUTH_JWKS_TTL_SECS` on every verifier** to speed rollout, then restart verifiers.
4. **Audit the proxy access log** for unexpected `sender` values or scope escalations during the exposure window.
5. **Audit the runtime-side auth log** to see which tokens were actually *used* during the window.
6. **Notify downstream operators** and file an incident record with timestamps, exposed kid, rotation time, and affected sender identities.
7. **Post-rotation: run a deployment audit** — confirm the secret store held no stale copies of the compromised JWK, and confirm CI / ops tooling rotated any cached values.

## Incident checklist: unauthorized access to the mint endpoint

If you discover that `POST /tokens` was reachable from an untrusted network:

1. **Restrict network access immediately** — update the reverse proxy, firewall, or service mesh to block the exposure.
2. **Treat every active token as potentially compromised.** Rotate the signing key as in the compromise runbook.
3. **Audit the proxy access log** for every request during the exposure window — especially unrecognized `sender` values.
4. **Confirm no log-based persistence issues.** The auth-service does not persist, but upstream audit logs may contain sensitive `sender` values and should be reviewed for further exposure.
