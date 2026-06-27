# Integration Guide

This guide is for engineers wiring the auth-service into a larger MACP deployment. It shows the full end-to-end flow from token mint to runtime verification, explains the two roles that consume this service (minting orchestrators and bearer-presenting SDK agents), and gives reference snippets in TypeScript, Rust, and Python.

For the architectural rationale behind direct-agent-auth, see RFC-MACP-0004 §4 and the [protocol security documentation](https://www.multiagentcoordinationprotocol.io/docs/security). For companion views from the other side of the wire, see:

- [Runtime — JWT mode](https://github.com/multiagentcoordinationprotocol/macp-runtime/blob/main/docs/getting-started.md#jwt-mode) and [Runtime — Deployment › Authentication](https://github.com/multiagentcoordinationprotocol/macp-runtime/blob/main/docs/deployment.md#authentication) — how the runtime verifies tokens this service issues.
- [Control-plane — Integration](https://github.com/multiagentcoordinationprotocol/macp-control-plane/blob/main/docs/INTEGRATION.md) and [Control-plane — Architecture](https://github.com/multiagentcoordinationprotocol/macp-control-plane/blob/main/docs/ARCHITECTURE.md) — how the reference orchestrator mints tokens and hands them to agents.
- [TypeScript SDK — Authentication](https://github.com/multiagentcoordinationprotocol/macp-sdk-typescript/blob/main/docs/guides/authentication.md) and [Python SDK — Direct-agent-auth](https://github.com/multiagentcoordinationprotocol/macp-sdk-python/blob/main/docs/guides/direct-agent-auth.md) — how SDK agents consume a minted JWT.

## Two roles, one identity provider

Anything that talks to the auth-service plays exactly one of these two roles.

**Minters** call `POST /tokens`. They hold a trust relationship with the auth-service (typically intra-cluster network, optionally reinforced by a proxy-level auth check) and are authorised to issue identities to agents. In the reference stack, the [control-plane](https://github.com/multiagentcoordinationprotocol/macp-control-plane) is the primary minter. Any orchestrator built directly on the [TypeScript SDK](https://github.com/multiagentcoordinationprotocol/macp-sdk-typescript) or [Python SDK](https://github.com/multiagentcoordinationprotocol/macp-sdk-python) can mint the same way — the SDKs ship with sample provisioning paths but do not themselves call `POST /tokens`.

**Bearers** present a minted JWT to the runtime on every gRPC frame. SDK-based agents are the canonical bearers: they load `runtime.bearerToken` from their bootstrap payload, wrap it in `Auth.bearer(...)` / `AuthConfig.for_bearer(...)`, and let the SDK attach it as `Authorization: Bearer <JWT>` metadata on every RPC. Bearers never touch the auth-service directly — their only relationship with it is indirect, via the `iss` / `aud` / `kid` on the tokens they carry.

The control-plane typically plays both roles: it mints tokens for agents it provisions, and it presents its own token when it talks to the runtime on its own behalf (for example to list sessions or install a policy).

## End-to-end flow

```
┌─────────────────────┐              ┌──────────────────┐              ┌──────────────────┐
│  Minter             │              │  auth-service    │              │  MACP runtime    │
│  (control-plane /   │              │  :3200           │              │  :50051 (gRPC)   │
│   SDK orchestrator) │              │                  │              │                  │
└──────────┬──────────┘              └────────┬─────────┘              └─────────┬────────┘
           │                                  │                                  │
           │  1. POST /tokens                 │                                  │
           │     { sender, scopes, ttl }      │                                  │
           ├─────────────────────────────────►│                                  │
           │                                  │                                  │
           │  2. { token, expires_in_secs }   │                                  │
           │◄─────────────────────────────────┤                                  │
           │                                  │                                  │
           │  3. bootstrap agent with         │                                  │
           │     runtime.bearerToken = token  │                                  │
           │                                  │                                  │
           │                                  │   4. GET /.well-known/jwks.json  │
           │                                  │      (runtime-initiated, cached) │
           │                                  │◄─────────────────────────────────┤
           │                                  │                                  │
           │                                  │   5. JWKS response               │
           │                                  ├─────────────────────────────────►│
           │                                  │                                  │

           ┌─────────────────────┐                                     ┌──────────────────┐
           │  SDK agent (bearer) │                                     │  MACP runtime    │
           │  TS / Python        │                                     │                  │
           └──────────┬──────────┘                                     └─────────┬────────┘
                      │                                                          │
                      │   6. gRPC frame                                          │
                      │      metadata: authorization = Bearer <token>            │
                      ├─────────────────────────────────────────────────────────►│
                      │                                                          │
                      │   7. runtime verifies sig + iss + aud + exp against      │
                      │      cached JWKS; maps sub → sender identity and         │
                      │      macp_scopes → capability set                        │
                      │                                                          │
```

1. A minter — the control-plane or a custom orchestrator built on an SDK — asks the auth-service to mint a JWT for a specific `sender` with specific scopes.
2. The auth-service returns a signed JWT with the effective TTL.
3. The minter hands the token to the agent it is spawning, typically by embedding it in the bootstrap payload at `runtime.bearerToken`.
4. On first use, the runtime fetches the auth-service's JWKS at `MACP_AUTH_JWKS_URL` and caches it for `MACP_AUTH_JWKS_TTL_SECS`.
5. The runtime holds the JWKS in memory until the TTL expires.
6. The SDK agent opens a gRPC channel, wraps the bootstrap token in an `Auth` / `AuthConfig`, and sends every frame with `Authorization: Bearer <token>` metadata. The SDKs attach this automatically.
7. The runtime verifies signature, `iss`, `aud`, and `exp` on every frame. A successful verify maps the JWT's `sub` to the authenticated sender identity and the `macp_scopes` claim to the capability set.

The auth-service is **not** in the hot path of a running session. Tokens are minted once at agent provisioning and reused for the session's lifetime.

## Minter patterns

### Pattern 1: control-plane provisions an agent

The [control-plane](https://github.com/multiagentcoordinationprotocol/macp-control-plane) is invoked by a human operator, a CI pipeline, or an upstream orchestration system. It enforces its own authorization policy, mints a scoped token for the target agent, and hands the bootstrap payload to the agent runner. This is the primary minting path in the reference stack.

```typescript
async function provisionAgent(req: ProvisionRequest, operator: OperatorIdentity): Promise<AgentHandle> {
  // 1. Authorize the operator (outside the scope of the auth-service).
  await authorizeOperator(operator, req.targetSender);

  // 2. Compute the scopes the operator may grant. May be narrower than what
  //    they requested, based on the operator's own role.
  const scopes = narrowScopes(req.scopes, operator);

  // 3. Mint the token.
  const token = await mintToken({
    sender: req.targetSender,
    scopes,
    ttl_seconds: Math.min(req.ttlSeconds ?? 3600, 3600),
  });

  // 4. Build the bootstrap payload the agent will consume.
  const bootstrap = {
    runtime: { address: 'macp-runtime:50051', bearerToken: token, tls: true },
    participant: { participantId: req.targetSender },
    run: { sessionId: req.preallocatedSessionId },
    // ...scenario-specific fields
  };
  return spawn(req.targetSender, bootstrap);
}
```

The control-plane is also the primary reason `POST /tokens` is unauthenticated at the service itself — operator authorization happens *before* the mint call, in the control-plane's own policy layer. If you deviate from that topology (for example, by exposing the auth-service to a less trusted network), add caller authentication at the reverse proxy.

For the control-plane's own operator-facing surface and integration contract, see [Control-plane INTEGRATION](https://github.com/multiagentcoordinationprotocol/macp-control-plane/blob/main/docs/INTEGRATION.md) and [Control-plane ARCHITECTURE](https://github.com/multiagentcoordinationprotocol/macp-control-plane/blob/main/docs/ARCHITECTURE.md).

### Pattern 2: custom orchestrator built on an SDK

When you build an orchestrator directly on the [TypeScript SDK](https://github.com/multiagentcoordinationprotocol/macp-sdk-typescript) or [Python SDK](https://github.com/multiagentcoordinationprotocol/macp-sdk-python), your orchestrator plays the same minter role as the control-plane: it calls `POST /tokens` per agent, embeds the JWT in the bootstrap payload, then spawns the agent. The SDKs themselves are agent-side libraries — they present tokens but do not mint them.

Typical flow for an SDK-based orchestrator:

```typescript
// Per agent to provision:
async function mintTokenForAgent(senderId: string): Promise<string> {
  const resp = await fetch('http://auth-service:3200/tokens', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      sender: senderId,
      scopes: {
        can_start_sessions: true,
        is_observer: false,
        allowed_modes: ['macp.mode.decision.v1'],
        max_open_sessions: 1,
      },
      ttl_seconds: 3600,
    }),
  });
  if (!resp.ok) {
    throw new Error(`Token mint failed: ${resp.status} ${await resp.text()}`);
  }
  const { token } = (await resp.json()) as { token: string };
  return token;
}

// Build the bootstrap the SDK agent will consume on startup.
// The shape is documented on the agent side — see the SDK auth guides.
const bootstrap = {
  runtime: {
    address: 'macp-runtime:50051',
    bearerToken: await mintTokenForAgent('agent://risk'),
    tls: true,
  },
  participant: { participantId: 'agent://risk' },
  run: { sessionId: preallocatedSessionId },
  // ...scenario-specific configuration
};
spawnAgent(bootstrap);
```

The bootstrap contract and the SDK-side consumption pattern are documented in the SDK guides — see [TypeScript SDK — Authentication](https://github.com/multiagentcoordinationprotocol/macp-sdk-typescript/blob/main/docs/guides/authentication.md) and [Python SDK — Direct-agent-auth](https://github.com/multiagentcoordinationprotocol/macp-sdk-python/blob/main/docs/guides/direct-agent-auth.md).

### Pattern 3: ad-hoc tooling

Direct curl for debugging, demo scripts, or one-off operator tools:

```bash
TOKEN=$(curl -sS -X POST http://localhost:3200/tokens \
  -H 'content-type: application/json' \
  -d '{"sender":"operator:alice","scopes":{"can_start_sessions":true}}' \
  | jq -r .token)

# Use the token with grpcurl to hit the runtime
grpcurl -H "authorization: Bearer ${TOKEN}" -d '{}' \
  macp-runtime:50051 macp.v1.MACPRuntimeService/Initialize
```

## Bearer pattern: SDK agents

Agents built on the SDKs are pure bearers. They receive a minted JWT in their bootstrap, wrap it in the SDK's auth helper, and let the SDK attach `Authorization: Bearer <JWT>` on every gRPC frame. The SDKs also enforce an `expectedSender` identity guard that fails fast client-side if the `sender` on an outgoing envelope disagrees with the one the token will authenticate as — saving a runtime `UNAUTHENTICATED` round trip.

### TypeScript

```typescript
import { Auth, DecisionSession, MacpClient } from 'macp-sdk-typescript';

// Values loaded from the orchestrator-supplied bootstrap:
const runtimeAddress = bootstrap.runtime.address;
const bearerToken = bootstrap.runtime.bearerToken;       // minted by this service
const participantId = bootstrap.participant.participantId;
const sessionId = bootstrap.run.sessionId;

const auth = Auth.bearer(bearerToken, { expectedSender: participantId });
const client = new MacpClient({ address: runtimeAddress, auth });
await client.initialize();

const session = new DecisionSession(client, { sessionId, auth });
// ... agent-specific flow: session.start(...), session.propose(...), etc.
```

See [TypeScript SDK — Authentication](https://github.com/multiagentcoordinationprotocol/macp-sdk-typescript/blob/main/docs/guides/authentication.md) for the full auth surface, including per-operation auth, session-level defaults, and the identity guard.

### Python

```python
from macp_sdk import AuthConfig, DecisionSession, MacpClient

bearer_token = bootstrap["runtime"]["bearerToken"]       # minted by this service
participant_id = bootstrap["participant"]["participantId"]
session_id = bootstrap["run"]["sessionId"]

auth = AuthConfig.for_bearer(bearer_token, expected_sender=participant_id)

client = MacpClient(target=bootstrap["runtime"]["address"], auth=auth)
client.initialize()

session = DecisionSession(client, session_id=session_id, auth=auth)
# ... agent-specific flow ...
```

See [Python SDK — Direct-agent-auth](https://github.com/multiagentcoordinationprotocol/macp-sdk-python/blob/main/docs/guides/direct-agent-auth.md) for the initiator/non-initiator distinction, session pre-allocation, and cancellation patterns.

### Why `expectedSender` matters

The runtime derives the envelope `sender` from the authenticated identity; a spoofed `sender=` fails at the runtime with `UNAUTHENTICATED`. Setting `expectedSender` on the SDK auth lets the SDK catch the mistake locally and raise `MacpIdentityMismatchError` **before** the envelope hits the wire. Clearer traceback, no wasted RTT, and no ambiguity about whose identity the session was bound to. The SDK auth guides have detailed examples.

## Runtime wiring

The runtime must be told where to fetch the JWKS and which `iss` / `aud` to expect.

```bash
export MACP_AUTH_ISSUER=macp-auth-service
export MACP_AUTH_AUDIENCE=macp-runtime
export MACP_AUTH_JWKS_URL=http://auth-service:3200/.well-known/jwks.json
export MACP_AUTH_JWKS_TTL_SECS=300
# Runtime's own config: bind addr, TLS, storage, etc.
export MACP_BIND_ADDR=0.0.0.0:50051
export MACP_ALLOW_INSECURE=1   # or MACP_TLS_CERT_PATH / MACP_TLS_KEY_PATH in prod
cargo run --manifest-path runtime/Cargo.toml
```

When `MACP_AUTH_ISSUER` is set, the runtime's JWT resolver activates and the static-bearer resolver is bypassed for JWT-shaped tokens (tokens containing dots). If you configure **both** a JWT issuer and a static `MACP_AUTH_TOKENS_FILE`, the runtime runs the JWT resolver first, then the static resolver. Dev-mode fallback is only active when **neither** is configured.

## Reference snippets: minting

### TypeScript / Node

```typescript
import { mintToken } from './mintToken';

const token = await mintToken({
  sender: 'agent://risk',
  scopes: { can_start_sessions: true, allowed_modes: ['macp.mode.decision.v1'] },
  ttl_seconds: 3600,
});
```

```typescript
// mintToken.ts
export interface MintArgs {
  sender: string;
  scopes?: Record<string, unknown>;
  ttl_seconds?: number;
}
export async function mintToken(args: MintArgs, baseUrl = process.env.AUTH_SERVICE_URL ?? 'http://auth-service:3200'): Promise<string> {
  const resp = await fetch(`${baseUrl}/tokens`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(args),
  });
  if (!resp.ok) {
    throw new Error(`mint failed: ${resp.status} ${await resp.text()}`);
  }
  const { token } = (await resp.json()) as { token: string };
  return token;
}
```

### Rust

```rust
use reqwest::Client;
use serde::{Deserialize, Serialize};

#[derive(Serialize)]
struct MintReq<'a> {
    sender: &'a str,
    scopes: serde_json::Value,
    ttl_seconds: u64,
}

#[derive(Deserialize)]
struct MintResp {
    token: String,
    expires_in_seconds: u64,
}

pub async fn mint(base: &str, sender: &str, ttl: u64) -> anyhow::Result<MintResp> {
    let body = MintReq {
        sender,
        scopes: serde_json::json!({
            "can_start_sessions": true,
            "allowed_modes": ["macp.mode.decision.v1"],
        }),
        ttl_seconds: ttl,
    };
    let resp = Client::new()
        .post(format!("{base}/tokens"))
        .json(&body)
        .send()
        .await?
        .error_for_status()?
        .json::<MintResp>()
        .await?;
    Ok(resp)
}
```

### Python

```python
import httpx

def mint_token(base_url: str, sender: str, ttl_seconds: int = 3600) -> str:
    resp = httpx.post(
        f"{base_url}/tokens",
        json={
            "sender": sender,
            "scopes": {
                "can_start_sessions": True,
                "allowed_modes": ["macp.mode.decision.v1"],
            },
            "ttl_seconds": ttl_seconds,
        },
        timeout=5.0,
    )
    resp.raise_for_status()
    return resp.json()["token"]
```

## Reference snippets: verifying

You typically do not verify tokens yourself — the runtime does that for you. These snippets are useful for debugging or for non-runtime verifiers (e.g. auxiliary services that also want to trust the same identity provider).

### TypeScript / Node

```typescript
import { jwtVerify, createRemoteJWKSet } from 'jose';

const JWKS = createRemoteJWKSet(new URL('http://auth-service:3200/.well-known/jwks.json'));

export async function verifyMacpToken(token: string) {
  const { payload } = await jwtVerify(token, JWKS, {
    issuer: process.env.MACP_AUTH_ISSUER ?? 'macp-auth-service',
    audience: process.env.MACP_AUTH_AUDIENCE ?? 'macp-runtime',
  });
  return {
    sender: payload.sub as string,
    scopes: (payload as any).macp_scopes as Record<string, unknown>,
  };
}
```

### Rust (reference — see runtime for production-grade impl)

```rust
use jsonwebtoken::{decode, DecodingKey, Validation, Algorithm};

#[derive(serde::Deserialize)]
struct Claims {
    sub: String,
    iss: String,
    aud: String,
    exp: usize,
    macp_scopes: serde_json::Value,
}

pub fn verify(token: &str, jwks_key: &DecodingKey) -> anyhow::Result<Claims> {
    let mut validation = Validation::new(Algorithm::RS256);
    validation.set_issuer(&["macp-auth-service"]);
    validation.set_audience(&["macp-runtime"]);
    let data = decode::<Claims>(token, jwks_key, &validation)?;
    Ok(data.claims)
}
```

If the auth-service is configured with `MACP_AUTH_SIGNING_ALG=ES256`, construct the validation with `Algorithm::ES256` instead (the runtime allows both). The `jose` snippet above needs no change — it selects the algorithm from the advertised JWKS automatically.

## Scopes model

The auth-service serializes scopes verbatim into the `macp_scopes` claim — it does **not** interpret them. Interpretation lives in the runtime. The canonical fields the runtime understands are:

| Field | Type | Meaning |
|-------|------|---------|
| `can_start_sessions` | boolean | May submit `SessionStart` envelopes. |
| `can_manage_mode_registry` | boolean | May register/unregister/promote extension modes. |
| `is_observer` | boolean | May passive-subscribe to sessions they are not a participant of. |
| `allowed_modes` | string[] | Non-empty = restrict to these mode ids; empty or omitted = all modes. |
| `max_open_sessions` | number | Upper bound on concurrent open sessions initiated by this sender. |

Because the mint endpoint passes scopes through unmodified, any additional keys you add are surfaced to the runtime. The runtime ignores unknown scope fields for forward compatibility — you can safely extend the shape as long as the runtime's enforcement logic is updated in lockstep.

## Common integration mistakes

| Mistake | Symptom | Fix |
|---------|---------|-----|
| `MACP_AUTH_ISSUER` differs between auth-service and runtime | Every mint fails verification with `JWTClaimValidationFailed: iss` | Set both from the same config source. |
| `MACP_AUTH_AUDIENCE` differs | Same, with `aud` | Same fix. |
| Caller forgets to set `content-type: application/json` on mint requests | `400 sender is required` even with `sender` in body | `express.json()` only parses when the header is correct. Set it. |
| Caller passes `ttl_seconds: 0` | `400 ttl_seconds must be a positive number` | Omit the field (defaults apply) or pass a positive number. |
| Agent retries a token after `exp` | Runtime returns `UNAUTHENTICATED` | Mint a fresh token; tokens are not refreshed server-side. |
| Runtime started before the auth-service is reachable | First mint-backed request fails with `UNAUTHENTICATED` because JWKS fetch errored | Ensure orchestration starts auth-service first, or make the runtime's JWKS fetch resilient (retry with backoff). |
| Two auth-service replicas with different `MACP_AUTH_SIGNING_KEY_JSON` | Intermittent `JWSSignatureVerificationFailed` depending on which replica served the JWKS last | Every replica in a deployment must share the same key. Use a single secret source. |

## Observability tips for callers

The auth-service does not log mints. If you need an audit trail, instrument it **in the caller**:

```typescript
async function mintTokenAudited(args: MintArgs, context: CallerContext): Promise<string> {
  const start = Date.now();
  try {
    const token = await mintToken(args);
    auditLog.info({
      event: 'token.minted',
      caller: context.caller,
      target_sender: args.sender,
      scopes: args.scopes,
      ttl_requested: args.ttl_seconds,
      duration_ms: Date.now() - start,
    });
    return token;
  } catch (err) {
    auditLog.error({
      event: 'token.mint_failed',
      caller: context.caller,
      target_sender: args.sender,
      error: (err as Error).message,
      duration_ms: Date.now() - start,
    });
    throw err;
  }
}
```

Treat the resulting log as security-sensitive — it reveals which identities exist and which capabilities they hold.
