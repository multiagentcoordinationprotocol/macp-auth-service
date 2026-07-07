# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in this project, please report it responsibly:

1. **Do not** open a public GitHub issue.
2. Email the maintainers or use GitHub's [private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability).

We aim to acknowledge reports within 48 hours and will work with you to address the issue.

## Security Considerations

This service issues short-lived RS256 bearer tokens used by MACP agents to authenticate directly to the runtime (RFC-MACP-0004 §4). Its security posture matters because a compromised mint is effectively a compromise of every identity in the system.

- **`POST /tokens` has no client authentication by default.** It assumes a trusted intra-cluster network. Before exposing this service outside the cluster, put it behind mTLS, an authenticating reverse proxy, or add a shared-secret `Authorization` check on the endpoint.
- **Signing key lifetime.** Any deployment beyond a single local dev box must set `MACP_AUTH_SIGNING_KEY_JSON`. Without it the service generates an ephemeral RSA keypair on every start — the runtime's JWKS cache (`MACP_AUTH_JWKS_TTL_SECS`, default 300 s) will reject tokens minted before a restart.
- **Key rotation.** Generate a new JWK with a fresh `kid`, deploy, and wait one `MACP_AUTH_JWKS_TTL_SECS` window. In-flight tokens signed with the prior `kid` remain valid until they expire; new mints use the new key. There is no revocation list — keep TTLs short if rapid revocation matters. Note (runtime ≥ 0.5.0): the one-window convergence bound holds only while the JWKS endpoint is reachable; a verifier that cannot refresh serves the old key set under a stale-cache grace for up to `TTL + 3600 s`, so endpoint availability is part of the revocation guarantee. A verifier restart is the hard cutoff — see the [Operations Runbook](docs/operations.md#key-rotation).
- **Secret handling.** `MACP_AUTH_SIGNING_KEY_JSON` must come from a secret store (Kubernetes Secret, Vault, AWS Secrets Manager, etc.) and be mounted at runtime. Never commit a private JWK.
- **No request logging of tokens.** The service logs the `sender` and TTL on mint but never logs the JWT itself.
- **Container hardening.** The published image runs as non-root (`appuser`), ships only `node` + production dependencies, and exposes an unauthenticated `/healthz` only.
- **Transport.** The service speaks plain HTTP. TLS termination is expected at the ingress. If you run it elsewhere, front it with a TLS proxy — tokens must not traverse plaintext links outside the cluster.

## What this service does NOT do

- It does **not** authenticate the caller of `/tokens` — anyone who can reach the port can mint tokens for any `sender`.
- It does **not** maintain a token revocation list.
- It does **not** persist minted tokens — restarting loses issuance history.
- It does **not** rate-limit requests. Put a proxy in front if you need that.
