# Progress — absorb-runtime-v0.8.1

Repo map gathered while writing `plans/absorb-runtime-v0.8.1.md`. `/implement` should read this
instead of re-scanning the repo from scratch.

**PR strategy:** one PR at the end, covering all three phases. All three phases are docs/comment-only,
touch a small overlapping set of files (`docs/`, `CLAUDE.md`, `CHANGELOG.md`, two `.spec.ts` comment
blocks), and are meaningful only together as "this repo re-verified against the current sibling
versions" — splitting them into separate PRs would just be review overhead with no independent
deploy value, unlike the prior `absorb-runtime-v0.5.0` pass which had a real reason to slice (T7's
e2e script depended on T1–T6 landing first). Phases are still committed individually on the feature
branch for a readable history and a real restore point.

**Branch:** `absorb-runtime-v0.8.1`.

## Phase list

1. Re-pin the exact verified-against runtime version (v0.5.0 → v0.8.1). **DONE**
2. Document two integration footguns (`MACP_AUTH_JWKS_JSON` precedence/malformed-fallback;
   `can_manage_mode_registry` under-description).
3. Fix the incidental `CLAUDE.md` `@types/node` doc-freshness gap; full regression pass.

## Phase log

### Phase 1 — DONE (2026-09-22)
- Verdict: **PASS**, round 1, fresh Opus verifier (agent `a6ce848d7592482b9`).
- Files touched: `src/contract.spec.ts` (2 comment lines), `src/keys.spec.ts` (1 comment line),
  `README.md:156`, `scripts/e2e-runtime.sh:4`, `CHANGELOG.md` (1 additive bullet under
  `[Unreleased] > Changed`).
- Gates: `npm test` 54/54 passed, `npm run lint` clean, `npm run typecheck` clean — all re-run
  independently by the verifier, not just trusted from the executor's report.
- No gaps, no assumptions logged (every edit traced directly to a plan-cited file:line).
- Next: Phase 2 (docs/integration.md + docs/operations.md footguns).

## This repo (`auth-service`)

- `src/config.ts` — env-driven config; `SigningAlg = 'RS256' | 'ES256'`, `parseSigningAlg` throws on
  anything else (already correctly documents "runtime ≥ 0.5.0" as a floor, not touched by this plan).
- `src/keys.ts` — `loadKey()`: ephemeral or `MACP_AUTH_SIGNING_KEY_JSON`-sourced keypair; every JWKS
  key gets a `kid` (`'dev-key-1'` ephemeral, `keyData.kid ?? 'key-1'` pinned).
- `src/server.ts` — `createApp()`; `MintScopes`/`MintRequestBody`/`MintResponseBody` interfaces
  (lines 7-25); `POST /tokens` handler (55-95) builds the JWT and sets `kid` in the protected header.
- `src/contract.spec.ts` — cross-service contract test; header comment (lines 8-30) names the
  verified-against runtime version — **Phase 1 target**. Asserts exact `macp_scopes` field set via
  `RUNTIME_SCOPE_FIELDS` (lines 32-38).
- `src/keys.spec.ts` — JWKS `kid`/`alg`/`use` contract test; comment at line 6 names the runtime
  version — **Phase 1 target**.
- `README.md:156` — names an exact runtime version for the e2e script — **Phase 1 target**.
  `README.md:120-138` — key rotation snippet, already correctly phrased as "runtime ≥ 0.5.0", not touched.
- `CLAUDE.md` — "Dependency constraints" section, `@types/node@^20.x` line — **Phase 3 target**
  (stale; actual `package.json` pins `^26.4.0`). Everything else in CLAUDE.md already reflects the
  v0.5.0 absorb pass correctly (HS256 caveat, env var table) and needs no change.
- `CHANGELOG.md` — `[Unreleased]` section is where the historical v0.5.0 absorb entry lives (leave
  as-is) and where **Phase 1** adds a new entry for this re-verification pass.
- `docs/integration.md` — "Runtime wiring" section (~lines 221-241) — **Phase 2 target**
  (`MACP_AUTH_JWKS_JSON` precedence note).
- `docs/operations.md` — "Common failures" section (~lines 138-190) — **Phase 2 target** (new
  failure-mode row).
- `scripts/e2e-runtime.sh` — opt-in Docker-based e2e script from the v0.5.0 pass's T7; header
  comments name the runtime version at lines 4, 11, 17, 24 — **Phase 1 target** (lines 4, 17 are
  exact-version claims; 11, 24 already use the `>= 0.5.0` floor phrasing and are left alone).
- `plans/absorb-runtime-v0.5.0.md` — the prior absorb plan, **fully executed** (its T1–T7 all landed:
  HS256 doc purge, JWKS latency guidance, rotation-under-stale-grace guidance, the `kid`/`alg`/`use`
  test in `src/keys.spec.ts`, runtime-wiring env-var additions, dev-mode gate corrections, and the
  `scripts/e2e-runtime.sh` e2e script). Used as the template for this plan's structure and citation
  discipline. **Do not edit — historical record.**

## Sibling repos (read-only ground truth for this plan)

- `../macp-runtime` (v0.8.1, commit `2ce6480`):
  - `crates/macp-auth/src/auth/resolvers/jwt_bearer.rs:8-27` — `MACPClaims`/`MACPScopes`, unchanged
    since v0.5.0.
  - `crates/macp-auth/src/security.rs:268-331` — alg allowlist default, JWKS env var precedence
    (`MACP_AUTH_JWKS_JSON` checked before `MACP_AUTH_JWKS_URL`, line 322 vs 331 — the Phase 2 finding).
  - `jwt_bearer.rs:64,130-186,274-299` — `STALE_GRACE`, single-flight refresh, `kid` selection.
  - `src/main.rs:422-443,483-487` — `MACP_ALLOW_INSECURE` startup gate.
  - `docs/deployment.md:292` — runtime's own doc bug (overstates alg allowlist as including HS256
    unconditionally); flagged upstream in the prior plan, still unfixed — **Open question 1**.
  - `crates/macp-auth/src/security.rs:322-338` — the full `MACP_AUTH_JWKS_JSON`/`_URL` branch: JSON
    checked first (322), URL only as an `else if` (331); a malformed inline JSON registers no JWT
    resolver at all (no fallback to the URL branch) — found by the Round-1 plan review, folded into
    Phase 2 alongside the precedence footgun.
  - `src/server.rs:1611,1645` — `RegisterPolicy`/`UnregisterPolicy` are also gated on
    `can_manage_mode_registry`, which `docs/integration.md:395` under-describes — found by the
    Round-1 plan review, added to Phase 2.
- `../macp-control-plane` (v0.3.0, commit `ab4e6b0`):
  - `src/runtime/runtime-jwt-minter.service.ts:66-99` — the actual `POST /tokens` call site.
  - `docs/ARCHITECTURE.md:77,353`, `docs/INTEGRATION.md:64,68,171-192` — its own docs, confirmed
    consistent with auth-service's contract.
- `../macp-sdk-typescript` (v0.11.0, commit `001bf73`):
  - `src/auth.ts` — `Auth.bearer`, `AuthConfig`, `assertSenderMatchesIdentity`,
    `MacpIdentityMismatchError` — confirmed unchanged, opaque to `macp_scopes`.
  - `package.json:35-37,62` — `engines.node >=20` unchanged; `@types/node@^26.4.0` (same pattern
    noted in this repo's `CLAUDE.md`, Phase 3).
- `../macp-sdk-python` (v0.9.1, commit `dad86b4`):
  - `src/macp_sdk/auth.py:7-74` — `AuthConfig`, `.for_bearer()`, `.metadata()` — confirmed unchanged,
    opaque to `macp_scopes`.
  - `docs/auth.md:63,73,77` — documents the `macp_scopes` field list (matches exactly) and the
    runtime's JWT-resolver behavior; deliberately never asserts auth-service-specific values.

## Investigation method

Four parallel background agents (one per sibling repo), each reading actual current source rather
than relying on CHANGELOGs/commit messages alone, per the `/plan` skill's "code is ground truth"
rule. All four returned "no drift" independently; findings cross-checked against each other for
consistency (e.g. both SDKs independently confirmed the `@types/node` pattern; the control-plane and
runtime audits independently confirmed the same 5-field `macp_scopes` shape).
