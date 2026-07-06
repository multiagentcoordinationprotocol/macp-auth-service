# Plan: absorb macp-runtime v0.5.0 (+ macp-proto 0.1.3→0.1.6, spec updates)

Status: proposed (not started)
Owner: auth-service maintainers
Scope: this repo only (`auth-service`). No code changes to the runtime are proposed here.
Ground truth verified against: `../macp-runtime` @ branch `feat/improvement-plan-phases-a-e`
(CHANGELOG `[0.5.0] — 2026-07-05`, `crates/macp-auth/`, `docs/change-review-phases-a-e.md`).

---

## 1. Context — what this service is and how it meets the runtime

The auth-service is a stateless Express + `jose` (v5, lockfile-resolved 5.10.0) JWT-minting
identity provider (RFC-MACP-0004 §4). It has exactly two runtime-facing surfaces:

1. **Token minting** — `POST /tokens` builds the JWT in `src/server.ts:60-69`:
   `jose.SignJWT({ macp_scopes })` with protected header
   `{ alg: signing.alg, kid: signing.jwks.keys[0]?.kid }` (`src/server.ts:63`),
   claims `sub` (= request `sender`), `iss` (`MACP_AUTH_ISSUER`, default
   `macp-auth-service`), `aud` (`MACP_AUTH_AUDIENCE`, default `macp-runtime`),
   `iat`, `exp` (`src/server.ts:64-68`, defaults in `src/config.ts:29-30`).
2. **Key distribution** — `GET /.well-known/jwks.json` serves the single public JWK built
   once by `loadKey()` (`src/server.ts:41-43`, `src/keys.ts:25-43`).

**Signing algorithms (code-verified):** `SigningAlg = 'RS256' | 'ES256'` (`src/config.ts:6`);
`parseSigningAlg` throws on any other value (`src/config.ts:18-24`), pinned by test
(`src/config.spec.ts:39-41`, expects `HS256` to throw). Default is RS256
(`src/config.ts:19`). **This service cannot mint HS256.** The runtime change-review's claim
("the sibling auth-service mints RS256 and is unaffected",
`../macp-runtime/docs/change-review-phases-a-e.md:300`) is **confirmed for code** — but
three *documentation* spots in this repo still describe the runtime as accepting HS256
(see item 1 below).

**`kid` status (code-verified):** every JWKS key carries a `kid` —
`'dev-key-1'` on the ephemeral path (`src/keys.ts:29`), `keyData.kid ?? 'key-1'` on the
pinned path (`src/keys.ts:39`) — and every minted token carries that same `kid` in its
protected header (`src/server.ts:63`). `src/contract.spec.ts:74-75` asserts
`protectedHeader.kid === signing.jwks.keys[0].kid` for both RS256 and ES256. The runtime's
new O(1) `kid`-based key selection therefore always takes the fast path for our tokens;
the try-all fallback is never exercised.

**JWKS shape:** always exactly one key, `{ kty, (n,e | x,y,crv), kid, alg, use: "sig" }`,
public material only (private components stripped by re-import, `src/keys.ts:37-38`).
There is deliberately no multi-key JWKS (`docs/architecture.md:166`).

**Claims contract:** `src/contract.spec.ts` pins the exact `macp_scopes` field set
(`can_start_sessions`, `can_manage_mode_registry`, `is_observer`, `allowed_modes`,
`max_open_sessions`) and types against the runtime's structs. Re-verified against runtime
v0.5.0: `MACPClaims`/`MACPScopes` in
`../macp-runtime/crates/macp-auth/src/auth/resolvers/jwt_bearer.rs:9-27` are field-for-field
identical (all optional, serde defaults). **No claim drift in v0.5.0.**

**What this repo does NOT contain (relevant to scoping):** no gRPC client, no protobuf /
`macp-proto` dependency (deps are exactly `express` + `jose`, `package.json`), no docker-compose
files, no CI job that runs a runtime binary (`.github/workflows/`: ci.yml = lint/typecheck/
build/test; docker.yml = image build/push; notify-website.yml = docs dispatch), and no
integration tests against a live runtime — the closest thing is `src/contract.spec.ts`
(offline wire-contract pin).

### Runtime v0.5.0 verifier behavior (ground truth, for reference)

- Default JWT alg allowlist `[RS256, ES256]`; `MACP_AUTH_JWT_ALGS` env overrides; HS256
  only via explicit opt-in (`../macp-runtime/crates/macp-auth/src/security.rs:164-189`).
- JWKS fetch: connect timeout 3 s, total timeout 5 s, HTTP client built once and reused
  (`.../resolvers/jwt_bearer.rs:172-179`).
- Stale-cache grace `STALE_GRACE = 3600s` (`.../jwt_bearer.rs:60-64`): served **only when a
  refresh attempt fails** (`.../jwt_bearer.rs:147-163`) — with a healthy endpoint, rotation
  still converges within `MACP_AUTH_JWKS_TTL_SECS` (default 300, `security.rs:160-163`).
- Single-flight refresh via `refresh_lock` (`.../jwt_bearer.rs:49,128-137`).
- `kid`-based key selection with try-all fallback (`.../jwt_bearer.rs:287-299`).
- Dev-mode auth gate: no tokens/issuer configured → startup refuses unless
  `MACP_ALLOW_INSECURE=1` (`../macp-runtime/src/main.rs:306-323`).
- `jsonwebtoken` 9.3.1 (runtime `Cargo.lock`); default 60 s validation leeway.

---

## 2. Impact matrix — every inventory item mapped

| # | Change | Impact | Evidence | Action |
|---|--------|--------|----------|--------|
| 1 | HS256 removed from runtime default allowlist | **Docs-only impact. Code unaffected.** | Service cannot mint HS256 (`src/config.ts:6,18-24`; `src/config.spec.ts:39-41`). Stale doc claims that the runtime accepts HS256: `CLAUDE.md:85`, `src/config.ts:5` (doc comment), `CHANGELOG.md:14` ([Unreleased] section). Full-repo grep found no other HS256 references. | Task T1: fix the three stale statements to "runtime default allowlist is RS256/ES256 (HS256 only via `MACP_AUTH_JWT_ALGS` opt-in)". |
| 2a | JWKS fetch timeouts (3 s connect / 5 s total) | **Docs impact (deploy guidance).** Service itself responds in µs (pre-computed JWKS object, `src/server.ts:41-43`); risk lives in proxies in front of it. | Runtime `jwt_bearer.rs:177-179`. Our nginx example proxies `/.well-known/jwks.json` (`docs/deployment.md:207-210`) with no timeout note; TLS-terminating proxies + cold DNS could approach 5 s. | Task T2: add a note to `docs/deployment.md` (TLS/proxy section) + `docs/operations.md` (monitoring) that the JWKS path must respond well under 5 s end-to-end including TLS handshake, and must not be gated by `auth_request`. |
| 2b | Stale-cache grace window (rotated-out keys may verify up to TTL+1h **if the JWKS endpoint is failing**) | **Docs impact — rotation runbook is now incomplete, worst for emergency rotation.** | Grace served only on fetch failure (`jwt_bearer.rs:147-163`). Our rotation docs all state convergence = one `MACP_AUTH_JWKS_TTL_SECS` window with no outage caveat: `SECURITY.md:18`, `docs/operations.md:69-93` (routine + emergency), `docs/deployment.md:50-62`, `docs/architecture.md:109-117`, `docs/API.md:71,183`, `README.md:129-131`, `docs/getting-started.md:204`. | Task T3 (the riskiest item — expanded in §4): update rotation guidance everywhere: healthy-endpoint bound unchanged (≤ TTL); outage bound = TTL + 1 h; emergency rotation must verify JWKS reachability from every verifier and use verifier restart as the hard cutoff. |
| 2c | `kid`-based key selection + try-all fallback | **No code impact — requirement already satisfied.** Positive side effect: our signature failures now have clean attribution. | `kid` always in JWKS (`src/keys.ts:29,39`) and in token header (`src/server.ts:63`); pinned by `src/contract.spec.ts:74-75`. | Task T4 (small): add an explicit test that *every* JWKS key has a string `kid`/`alg`/`use` (hardening against future multi-key work); mention the O(1) selection in `docs/integration.md`. No changes to signing code. |
| 2d | Single-flight refresh + reused HTTP client | **No impact; one monitoring doc line improved.** | Runtime-side fix (`jwt_bearer.rs:49,128-137`). Our monitoring table says "bursty fetches indicate a verifier-side caching bug" (`docs/operations.md:186`) — as of v0.5.0 thundering-herd is fixed, so bursts are even more anomalous. | Fold into T3/T5: refresh the monitoring row; note expected fetch rate ≤ 1/TTL per runtime process. |
| 3 | Runtime JWT config surface (`MACP_AUTH_ISSUER`/`AUDIENCE`/`JWT_ALGS`/`JWKS_JSON`/`JWKS_URL`/`JWKS_TTL_SECS`) | **Docs impact (additive).** Existing vars we document are all still correct; `MACP_AUTH_JWT_ALGS` is new and unmentioned; `MACP_AUTH_JWKS_JSON` (inline) also unmentioned in our runtime-wiring snippets. | Runtime `security.rs:156-189`. Our wiring snippets: `docs/integration.md:225-236`, `docs/deployment.md:174-188`, `docs/getting-started.md:187-196`, `README.md:30-38`. Defaults verified: audience `macp-runtime`, TTL 300. `SECURITY.md:17` says JWKS cache "default 60–300 s" — the default is exactly 300. | Task T5: add `MACP_AUTH_JWT_ALGS` (and its RS256/ES256 default) to the runtime-wiring sections; add "alg must be in the allowlist" to the token-rejection bullet list (`docs/deployment.md:181-187`); fix the `SECURITY.md:17` default; optionally mention `MACP_AUTH_JWKS_JSON` as the inline alternative. |
| 4 | JWT claims consumed by runtime (`sub` + `macp_scopes` object, 5 fields) | **No impact — verified aligned.** | Runtime structs (`jwt_bearer.rs:9-27`) == our contract pin (`src/contract.spec.ts:27-33,86-99`). Names, types, optionality all match. Runtime defaults on omission (start=true, registry=false, observer=false, all modes) match our docs (`docs/API.md:106,109-119`, `docs/integration.md:385-395`). | Confirm-only. Task T4 refreshes the stale path/comment in `src/contract.spec.ts:11` ("runtime/crates/macp-auth" → "macp-runtime/crates/macp-auth"; jsonwebtoken 9.x still correct at 9.3.1). |
| 5 | Dev-mode gate (`MACP_ALLOW_INSECURE=1` required with no auth configured; Docker image no longer bakes it) | **Docs impact (two spots).** No compose files or runtime-launching scripts exist in this repo (verified by find/grep). | `docs/integration.md:236` — "Dev-mode fallback is only active when neither is configured" is now incomplete: with neither configured the runtime **refuses to start** unless `MACP_ALLOW_INSECURE=1` (`../macp-runtime/src/main.rs:306-323`). `docs/getting-started.md:192` and `docs/integration.md:232` set the flag already (for plaintext), so those commands still work under v0.5.0 — but the comment "or MACP_TLS_* in prod" now under-describes what the flag gates. | Task T6: correct both passages; add a line that a bare `docker run` of the runtime image now fails fast without explicit auth config or the flag. |
| 6 | `WatchSignals` now requires authentication | **No impact.** | Zero references to WatchSignals/signals in this repo (grep). Tokens minted here are presented on *every* gRPC frame by the SDKs (`docs/integration.md:172-174`), so one more covered RPC changes nothing about minting or scopes (no signal-specific scope exists in `MACPScopes`). | Explicitly none. Optional one-line mention in T5's integration-guide touch-up. |
| 7 | Static token config unchanged (`MACP_AUTH_TOKENS_FILE`/`_JSON`) | **No impact; doc statement re-verified accurate.** | `docs/integration.md:236` resolver-order description matches runtime v0.5.0 behavior (JWT resolver first, static second, JWT-shaped vs opaque routing) per runtime `security.rs` + runtime `docs/getting-started.md` "Resolver order". | None (T6 touches the adjacent dev-mode sentence only). |
| 8 | macp-proto 0.1.4–0.1.6 (ContributePayload proto, `max_suspend_ms`, `HandoffAcceptPayload.implicit`, ListSessions pagination) | **No impact.** | This repo has no protobuf, no gRPC, no macp-proto dependency (`package.json` deps: express, jose only; repo-wide grep for `proto` finds nothing relevant). Tokens are payload-agnostic. Note: runtime `Cargo.lock` at HEAD actually resolves macp-proto **0.1.5**, not 0.1.6 — immaterial either way for this repo. | Explicitly none. |
| 9 | Runtime behavior changes (passive-subscribe ordinals, watch-lag RESOURCE_EXHAUSTED, 6 lifecycle states, policy echo, task external orchestrator, quorum thresholds, ext-mode strictness, roots `list_changed:false`, `MACP_POLICIES_DIR`, Prometheus `MACP_METRICS_ADDR`, graceful drain, 36-char base64url session IDs) | **No impact on any minting/JWKS surface.** One optional doc improvement. | The service never sees session IDs, modes' payloads, policies, or streams. Scope *semantics* we document are unchanged: `is_observer` still gates passive subscribe (runtime `docs/getting-started.md` JWT-mode section), `allowed_modes`/`max_open_sessions` unchanged. `docs/operations.md:186` cites "Runtime metrics" for JWKS fetch rate — now concretely available via `MACP_METRICS_ADDR` Prometheus endpoint. | Fold into T3/T5: reference `MACP_METRICS_ADDR` in the monitoring table. Otherwise explicitly none. |
| 10 | All seven runtime crates published at 0.5.0 (incl. `macp-auth`) | **No dependency impact; comment refresh only.** | This repo depends on none of the crates. It *mirrors* the verifier's claim structs in a test comment (`src/contract.spec.ts:10-24`) — struct shape re-verified unchanged at 0.5.0. | Task T4: update the comment to name macp-auth 0.5.0 as the verified-against version so the pin is auditable. |
| 11 | Upcoming: handoff synthetic accepts (runtime-emitted envelopes, sender = target, `implicit: true`) | **No impact now; watch item.** | Synthetic envelopes are *runtime-generated*, not authenticated through bearer tokens, so no token is minted for them and no JWKS interaction occurs. The only conceivable future intersection: if a spec revision ever required synthetic envelopes to carry a runtime-held identity/token, that would be a new minting client — nothing published suggests this. | Explicitly none. Recorded as a watch item in §5. |

### Definitive answers to the two mandated questions

- **RS256/HS256:** the auth-service mints **RS256 by default and ES256 by explicit opt-in;
  HS256 is impossible** (`src/config.ts:6,18-24`, enforced at startup, test-pinned at
  `src/config.spec.ts:39-41`). The runtime change-review claim is correct for code. Both
  mintable algorithms are inside the runtime's new default allowlist, so **no deployment of
  this service breaks under v0.5.0**. The residue is three stale doc/comment claims that the
  runtime accepts HS256 (`CLAUDE.md:85`, `src/config.ts:5`, `CHANGELOG.md:14`).
- **`kid`:** **yes on both sides, unconditionally** — JWKS key always has `kid`
  (`src/keys.ts:29,39`), token header always carries it (`src/server.ts:63`), equality pinned
  by `src/contract.spec.ts:74-75`. Runtime v0.5.0's O(1) selection always hits; try-all
  fallback never engages for our tokens.

---

## 3. Work plan

All tasks are docs/tests only — **zero production-code changes are required** (`src/config.ts:5`
is a comment edit). Estimates: S ≤ 1 h, M ≤ half day.

### T1 — Purge stale "runtime accepts HS256" claims (S)
- `CLAUDE.md:85`: "The runtime verifier accepts RS256/ES256/HS256" → "The runtime's default
  allowlist is RS256/ES256 (runtime ≥ 0.5.0; HS256 requires `MACP_AUTH_JWT_ALGS=HS256` on the
  runtime). This service mints RS256 or ES256."
- `src/config.ts:5` doc comment: same correction.
- `CHANGELOG.md:14` (in `[Unreleased]`, so amendable): reword "already accepts RS256/ES256/HS256"
  → "accepts RS256/ES256 by default (runtime 0.5.0)". Add a new `[Unreleased] > Changed` entry:
  "Docs aligned to macp-runtime v0.5.0 auth changes (HS256 default removal, JWKS hardening,
  dev-mode gate)."
- **DoD/test:** `grep -rn HS256` in repo returns only (a) the negative config test and (b)
  passages that correctly describe HS256 as runtime opt-in.

### T2 — JWKS endpoint latency guidance (S)
- `docs/deployment.md` (TLS termination + nginx snippet): note that runtime ≥ 0.5.0 aborts JWKS
  fetches at 3 s connect / 5 s total — the JWKS path must respond well under that including
  proxy+TLS overhead, and must never sit behind `auth_request` or an interactive challenge.
  The `Cache-Control: max-age=60` example remains fine.
- `docs/integration.md` "Common integration mistakes" table: update the "runtime started before
  auth-service reachable" row (`docs/integration.md:406`) — the runtime now retries on each auth
  attempt, has fetch timeouts, and serves stale keys within a 1 h grace on refresh failure, so
  the failure mode is transient rather than requiring runtime-side custom retry logic.
- **DoD:** both passages mention the 3 s/5 s bounds with the runtime version.

### T3 — Rotation guidance under stale-cache grace (M) — riskiest item, do most carefully
Files: `docs/operations.md` (§Key rotation, routine + emergency + monitoring),
`docs/deployment.md:50-62`, `docs/architecture.md:109-117`, `SECURITY.md:18`, `docs/API.md:71,183`,
`README.md:129-131`, `docs/getting-started.md:204`.
- State the precise v0.5.0 semantics: (a) healthy JWKS endpoint → verifiers converge within
  `MACP_AUTH_JWKS_TTL_SECS` (unchanged); (b) **failing/unreachable endpoint → verifiers keep
  serving the last-known key set for up to `TTL + 3600 s`** — a rotated-out key can verify that
  long; (c) a runtime restart clears the in-memory cache and is the hard cutoff.
- Emergency-rotation runbook additions: verify JWKS endpoint health *from every verifier's
  vantage* immediately after rolling the key (curl through the same URL the runtime uses);
  treat "rotated key must die now" as: rotate → confirm JWKS serves new kid → confirm each
  runtime logs a successful refresh (or restart runtimes); explicitly note an attacker who can
  DoS the JWKS endpoint extends the compromised key's life to TTL+1h — so the endpoint's
  availability is part of the revocation story.
- Monitoring table (`docs/operations.md:177-187`): fetch rate is now ≤ 1/TTL per runtime process
  (single-flight); runtime exposes Prometheus metrics via `MACP_METRICS_ADDR`; add "warn-level
  `JWKS refresh failed; serving stale cached keys` runtime log line" as the signal that grace
  mode is active.
- **DoD/test:** every doc statement of the form "wait one `MACP_AUTH_JWKS_TTL_SECS` window"
  carries the outage caveat or links to the runbook section that does; runbook contains the
  TTL+1h bound and the restart-as-hard-cutoff step.

### T4 — Test/comment hygiene (S)
- `src/contract.spec.ts:10-24`: update the header comment — verified-against version
  "macp-runtime v0.5.0 (`macp-runtime/crates/macp-auth`, jsonwebtoken 9.3.x)"; note HS256 is
  outside the runtime's default allowlist.
- Add a small test (in `src/keys.spec.ts` or `server.spec.ts`): every key in the served JWKS has
  string `kid`, `alg` ∈ {RS256, ES256}, `use === 'sig'` — for both ephemeral and pinned paths,
  both algs. This turns the `kid` guarantee the runtime's fast path relies on into an explicit
  contract instead of an incidental one.
- **DoD:** `npm test` green; new assertions fail if anyone removes `kid` from `loadKey()`.

### T5 — Runtime-wiring snippets: new config surface (S)
- `docs/integration.md:225-236`, `docs/deployment.md:174-188`, `docs/getting-started.md:187-196`,
  `README.md:30-38`: add `MACP_AUTH_JWT_ALGS` (default `RS256,ES256`) to the runtime env
  descriptions; extend the "token is rejected unless" list with "the header `alg` is in the
  runtime's allowlist"; fix `SECURITY.md:17` ("default 60–300 s" → "default 300 s"); optionally
  mention `MACP_AUTH_JWKS_JSON` as the inline JWKS alternative for air-gapped runtimes
  (works because our JWKS is stable when the key is pinned).
- Optional one-liner in integration.md: as of runtime 0.5.0 every RPC including `WatchSignals`
  requires authentication — no doc previously claimed otherwise, so this is additive.
- Minor: `docs/getting-started.md:193` / `docs/integration.md:233` use
  `--manifest-path ../runtime/Cargo.toml`; the sibling repo directory is `macp-runtime` — fix
  the path while in there.
- **DoD:** wiring snippets copy-paste-run against a v0.5.0 runtime (verified by T7).

### T6 — Dev-mode gate corrections (S)
- `docs/integration.md:236`: replace "Dev-mode fallback is only active when neither is
  configured" with the v0.5.0 rule: with neither configured the runtime **fails startup** unless
  `MACP_ALLOW_INSECURE=1`; the flag also still gates plaintext (no-TLS) operation.
- `docs/getting-started.md:190-193` comment: note the runtime starts fine here because JWT auth
  *is* configured; `MACP_ALLOW_INSECURE=1` in that snippet is for plaintext only.
- Add to both: the published runtime Docker image no longer bakes `MACP_ALLOW_INSECURE=1` in —
  a bare `docker run` of the runtime fails fast; pass auth env or the flag explicitly.
- **DoD:** grep for "dev-mode" / "ALLOW_INSECURE" in this repo shows only v0.5.0-accurate text.

### T7 — End-to-end verification against a live runtime v0.5.0 (M)
New `scripts/e2e-runtime.sh` (opt-in, not wired into `npm test`; requires Docker):
1. Start auth-service (ephemeral key) and runtime v0.5.0
   (`ghcr.io/multiagentcoordinationprotocol/...` image or `MACP_RUNTIME_BIN` env) on one Docker
   network, runtime configured with `MACP_AUTH_ISSUER=macp-auth-service`,
   `MACP_AUTH_JWKS_URL=http://auth:3200/.well-known/jwks.json`, `MACP_ALLOW_INSECURE=1`
   (plaintext), *no* static tokens.
2. Mint RS256 token via `POST /tokens`; call `Initialize` + `ListModes` with grpcurl using
   `authorization: Bearer <jwt>` → expect success (proves: RS256 in allowlist, JWKS fetch,
   kid fast path, iss/aud match, dev-gate satisfied by JWT config alone).
3. Repeat with `MACP_AUTH_SIGNING_ALG=ES256` → expect success.
4. Negative: call with a garbage bearer → expect `UNAUTHENTICATED` (proves no dev-mode
   any-token fallback leaked in).
5. (Manual, documented in the script header, not automated) rotation probe: restart
   auth-service to force a new ephemeral key, kill the JWKS route (stop the container),
   confirm the runtime keeps accepting old-key tokens (grace) and logs the stale-serve warning.
- **DoD:** script passes locally against runtime v0.5.0; README "Development" section gets a
  two-line pointer. Rationale for not gating CI on it: this repo's CI has no runtime image
  contract today; revisit after the ecosystem pins published images.

### Explicit non-actions (confirmed unaffected)
- No change to signing code, key loading, claim construction, scope passthrough, or endpoints.
- No dependency bumps required (`jose` 5.x pin unchanged; no macp-proto/crate deps exist).
- No CI/Docker changes required (workflows and Dockerfile have no runtime coupling).
- Items 6, 8, 9 (except one monitoring line), 10 (except a comment), 11: no work.

---

## 4. Risk notes

- **Rotation-timing under stale grace (highest risk if left undocumented):** operators
  following today's emergency runbook believe a compromised key dies one JWKS-TTL after
  rotation. Under v0.5.0 that is only true while the JWKS endpoint keeps answering; the true
  worst-case is `TTL + 3600 s`, and endpoint availability becomes part of the revocation
  guarantee. T3 exists to close exactly this gap. Mitigation until T3 lands: keep
  `MACP_AUTH_JWKS_TTL_SECS` short and restart runtimes after emergency rotation.
- **Doc drift is the only failure mode here.** Since no code changes, the residual risk is a
  reader following stale text (HS256, dev-mode fallback) — T1/T6 are cheap and should land first.
- **Cross-repo note (out of scope, worth flagging upstream):** the *runtime's own*
  `docs/getting-started.md` "JWT mode" still says "Supported signature algorithms are RS256,
  ES256, and HS256" without the opt-in caveat — inconsistent with its v0.5.0 CHANGELOG. Raise
  an issue on macp-runtime; do not mirror that sentence here.
- **Rollback:** every task is docs/tests; rollback = git revert of the slice. T7's script is
  additive and opt-in; deleting it restores the status quo. No deployment risk at any point.

## 5. Sequencing

Mergeable slices, in order; none is gated on external work:

1. **Slice 1 (land now): T1 + T6** — correctness fixes for statements that are *wrong* under
   v0.5.0 today. DoD: greps in T1/T6. No test changes needed beyond existing suite green.
2. **Slice 2 (land now): T3 + T2 + T5** — rotation/latency/config-surface guidance; one
   coherent docs PR since they touch the same files. DoD per task above; also triggers
   `notify-website.yml` docs sync on merge (expected, desired).
3. **Slice 3 (land now): T4** — test/comment hygiene; independent, tiny.
4. **Slice 4 (after 1–3): T7** — e2e script; validates that slices 1–2's snippets are true
   against the real v0.5.0 binary. Nothing is *gated* on it, but landing it last lets it verify
   the corrected docs.
- **Gated/none:** nothing here waits on macp-proto, spec, or other repos.
- **Watch items:** (a) handoff synthetic accepts (item 11) — re-check at the next runtime
  release for any auth-plane interaction; (b) if this service ever grows multi-key JWKS
  (currently ruled out, `docs/architecture.md:159-168`), v0.5.0's kid-selection makes overlap
  rotation viable — record as a future-design note, not a task.

---

## Revision log

### Pass 1 — completeness (inventory re-walk + auth-surface grep sweep)
- Re-walked all 11 inventory items against the matrix — all present, each with
  impacted/not-impacted verdict and evidence.
- Swept every auth-relevant surface for uncovered spots: signing calls (`src/server.ts` only),
  alg constants (`src/config.ts`, specs), JWKS route (`src/server.ts:41`), kid handling
  (`src/keys.ts`, `src/server.ts:63`), claim construction (`src/server.ts:60-69`), env docs
  (`.env.example`, README, CLAUDE.md, docs/*), compose files (none exist), Dockerfile
  (no runtime coupling), workflows (no runtime coupling), `dist/` (git-ignored build output).
- **Gaps found and added:** (a) `.env.example:21-23` says "The runtime accepts both" — already
  accurate under v0.5.0 (RS256/ES256 = exactly the new default) so *not* a T1 target; noted to
  prevent an over-eager edit. (b) `docs/integration.md:406` retry-guidance row — added to T2.
  (c) `docs/getting-started.md:193` stale `../runtime` path — added to T5. (d) Runtime-repo
  doc inconsistency (its own getting-started still lists HS256) — added as a §4 cross-repo flag.

### Pass 2 — adversarial verification (re-read code behind every file:line claim)
- Re-verified all line references in §1–§2 against current files: `src/config.ts:6,18-24`;
  `src/config.spec.ts:39-41` (line 40 is the assertion; cited as 39-41 for the `it` block);
  `src/keys.ts:29,39`; `src/server.ts:41-43,60-69,63`; `src/contract.spec.ts:74-75,27-33`;
  runtime `security.rs:164-189` (allowlist default), `jwt_bearer.rs:64` (STALE_GRACE),
  `:147-163` (grace only on fetch failure — **confirmed**: on a *successful* refresh the new
  keys replace the cache immediately at TTL expiry; grace never extends a healthy rotation),
  `:177-179` (3 s/5 s), `:287-299` (kid selection), `main.rs:306-323` (dev gate).
- **Corrections made:** (a) initial draft said rotated-out keys verify "up to TTL+1h" without
  qualification — tightened everywhere to "only while JWKS refresh is failing", which changes
  T3's guidance from "grace always applies" to "endpoint availability is part of revocation".
  (b) Versions from lockfiles: jose resolves to 5.10.0 (declared ^5.9.6) — cited both;
  jsonwebtoken 9.3.1; runtime `Cargo.lock` resolves macp-proto **0.1.5** (not 0.1.6 as the
  inventory suggested) — recorded in item 8 rather than silently repeating the inventory.
  (c) Confirmed `MACP_AUTH_AUDIENCE` runtime default `macp-runtime` and JWKS TTL default 300
  (`security.rs:158-163`), which makes `SECURITY.md:17`'s "60–300 s" wrong → kept in T5.
  (d) Checked `MACPScopes` for `deny_unknown_fields` — absent, so our "runtime ignores unknown
  scope keys" doc claim (`docs/integration.md:395`, `docs/API.md:119`) remains true at 0.5.0.
- No claims deleted; two claims tightened as above.

### Pass 3 — executability (slices, DoD, riskiest-item expansion, rollback)
- Reordered tasks into 4 independently mergeable slices (§5) with wrong-today fixes (T1/T6)
  first; added a per-task DoD/test line to T1–T7 (grep-based DoDs for doc tasks, `npm test`
  for T4, live-runtime checks for T7).
- Expanded the riskiest item (rotation semantics) into T3's step-level runbook changes plus a
  dedicated §4 risk entry with an interim mitigation (short TTL + verifier restart) usable
  before any doc lands.
- Made T7 concrete: exact env wiring, four automated assertions incl. one negative
  (garbage bearer → UNAUTHENTICATED, proving the dev-gate removal), and moved the
  stale-grace probe to a documented manual step (automating a timed 1 h grace window in CI is
  not proportionate).
- Added rollback notes (§4) — all-docs/tests nature means revert-per-slice with zero deploy
  risk — and noted the `notify-website.yml` side effect of docs merges so Slice 2 reviewers
  expect the website sync dispatch.
