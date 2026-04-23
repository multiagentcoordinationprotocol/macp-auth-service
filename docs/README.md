# MACP auth-service Documentation

**Version**: v1.0.0 | **Protocol**: MACP 1.0 | **Language**: TypeScript (Node 20+)

The MACP auth-service is the reference identity provider for the [Multi-Agent Coordination Protocol](https://www.multiagentcoordinationprotocol.io). It is a small, stateless Express service that mints short-lived RS256 JWTs for agents so they can authenticate directly to the MACP runtime over gRPC. It implements the identity-provider side of direct-agent-auth as described in RFC-MACP-0004 §4.

This documentation covers the **auth-service implementation** -- how to build, configure, integrate, deploy, and operate it. For protocol-level concepts like the authentication model, session capabilities, and the two-plane architecture, see the [protocol documentation](https://www.multiagentcoordinationprotocol.io/docs).

## What the auth-service provides

The service exposes three HTTP endpoints. `POST /tokens` mints a signed JWT for a requested `sender` identity with a scopes payload and a clamped time-to-live. `GET /.well-known/jwks.json` advertises the corresponding public JWK so that any MACP runtime pointed at this service can verify tokens without ever touching the private key. `GET /healthz` is an unauthenticated liveness probe for load balancers and container orchestrators.

The service sits between three kinds of consumer in a typical MACP deployment:

- **Orchestrators that mint.** The [control-plane](https://github.com/multiagentcoordinationprotocol/control-plane) and any custom orchestrator built on the [TypeScript SDK](https://github.com/multiagentcoordinationprotocol/typescript-sdk) or [Python SDK](https://github.com/multiagentcoordinationprotocol/python-sdk) call `POST /tokens` to obtain a JWT per agent they provision.
- **SDK-based agents that present.** Agents built with the SDKs receive a minted JWT in their bootstrap payload and carry it on every gRPC frame to the runtime. The SDKs themselves do not call `POST /tokens` — they are the bearer side of the exchange. See the SDK auth guides ([TypeScript](https://github.com/multiagentcoordinationprotocol/typescript-sdk/blob/main/docs/guides/authentication.md), [Python](https://github.com/multiagentcoordinationprotocol/python-sdk/blob/main/docs/guides/direct-agent-auth.md)).
- **The runtime that verifies.** The [runtime](https://github.com/multiagentcoordinationprotocol/runtime) fetches `/.well-known/jwks.json`, caches it, and verifies every incoming JWT's signature, `iss`, `aud`, and `exp`. See the runtime [Getting Started — JWT mode](https://github.com/multiagentcoordinationprotocol/runtime/blob/main/docs/getting-started.md#jwt-mode) and [Deployment — Authentication](https://github.com/multiagentcoordinationprotocol/runtime/blob/main/docs/deployment.md#authentication).

The service is stateless by design. It holds exactly one RSA keypair in memory for its lifetime, maintains no database, issues no refresh tokens, and keeps no revocation list. Short TTLs and key rotation are the mitigations for compromised tokens. In development the service generates an ephemeral keypair on start; in any shared environment you provide `MACP_AUTH_SIGNING_KEY_JSON` so the key survives restarts and the runtime's JWKS cache stays stable.

The mint endpoint is intentionally open-by-default: anyone who can reach the port can mint a token for any `sender`. That model assumes a trusted intra-cluster network. Deployments that expose the service more widely front it with mTLS, an authenticating reverse proxy, or a shared-secret `Authorization` check — see [Deployment](deployment.md) and [Operations](operations.md).

## Documentation

### Getting started
- [**Getting Started**](getting-started.md) -- Install, run locally, mint your first token, verify it against the JWKS
- [**Integration Guide**](integration.md) -- How the control-plane, SDK orchestrators, SDK agents, and the runtime consume this service end-to-end

### Implementation reference
- [**Architecture**](architecture.md) -- Module layout, request flow, key lifecycle, and the config / keys / server split
- [**API Reference**](API.md) -- All three HTTP endpoints with request/response fields, error codes, and JWT claim structure

### Operations
- [**Deployment**](deployment.md) -- Production checklist, environment variables, container deployment, TLS termination, and secret handling
- [**Operations Runbook**](operations.md) -- Key rotation, restart procedure, diagnostics, log interpretation, and common failure modes

## Protocol documentation

The auth-service implements the identity-provider side of the protocol's authentication model. For protocol-level topics, refer to the specification documentation:

| Topic | Link |
|-------|------|
| Security model and threat surface | [Protocol Security](https://www.multiagentcoordinationprotocol.io/docs/security) |
| Transport bindings (gRPC, JWT, JWKS) | [Protocol Transports](https://www.multiagentcoordinationprotocol.io/docs/transports) |
| Agent discovery and capability negotiation | [Protocol Discovery](https://www.multiagentcoordinationprotocol.io/docs/discovery) |
| Session lifecycle and participant model | [Protocol Lifecycle](https://www.multiagentcoordinationprotocol.io/docs/lifecycle) |

## Related repositories

| Repository | Role | Auth docs |
|------------|------|-----------|
| [multiagentcoordinationprotocol](https://github.com/multiagentcoordinationprotocol/multiagentcoordinationprotocol) | Protocol specification, RFCs, and canonical docs | [Security](https://www.multiagentcoordinationprotocol.io/docs/security) |
| [runtime](https://github.com/multiagentcoordinationprotocol/runtime) | Rust reference runtime that verifies JWTs issued by this service | [JWT mode](https://github.com/multiagentcoordinationprotocol/runtime/blob/main/docs/getting-started.md#jwt-mode), [Deployment auth](https://github.com/multiagentcoordinationprotocol/runtime/blob/main/docs/deployment.md#authentication) |
| [control-plane](https://github.com/multiagentcoordinationprotocol/control-plane) | Orchestrator that mints per-agent tokens via this service | [Integration](https://github.com/multiagentcoordinationprotocol/control-plane/blob/main/docs/INTEGRATION.md), [Architecture](https://github.com/multiagentcoordinationprotocol/control-plane/blob/main/docs/ARCHITECTURE.md) |
| [typescript-sdk](https://github.com/multiagentcoordinationprotocol/typescript-sdk) | TypeScript agent SDK — presents the JWT to the runtime | [Authentication guide](https://github.com/multiagentcoordinationprotocol/typescript-sdk/blob/main/docs/guides/authentication.md) |
| [python-sdk](https://github.com/multiagentcoordinationprotocol/python-sdk) | Python agent SDK — presents the JWT to the runtime | [Direct-agent-auth](https://github.com/multiagentcoordinationprotocol/python-sdk/blob/main/docs/guides/direct-agent-auth.md), [Auth overview](https://github.com/multiagentcoordinationprotocol/python-sdk/blob/main/docs/auth.md) |
| [auth-service](https://github.com/multiagentcoordinationprotocol/auth-service) | **This repository** — JWT minting identity provider | — |
