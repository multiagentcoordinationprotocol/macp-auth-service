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
   `can_manage_mode_registry` under-description). **DONE**
3. Fix the incidental `CLAUDE.md` `@types/node` doc-freshness gap; full regression pass. **DONE**

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

### Phase 2 — DONE (2026-09-22)
- Verdict: **PASS**, round 1, fresh Opus verifier (agent `a545c52afeb8102ab`), which independently
  re-checked the `MACP_AUTH_JWKS_JSON` precedence/malformed-fallback claims against
  `../macp-runtime/crates/macp-auth/src/security.rs:322-338` rather than trusting the plan's own
  citation.
- Files touched: `docs/integration.md` (new "Runtime wiring" paragraph at line 243; `Scopes model`
  table row reworded at line 397), `docs/operations.md` (new `###` subsection under "Common
  failures", lines 191-196).
- Gates: `npm test` 54/54, lint, typecheck all still green (docs-only phase; re-run as a baseline
  check before Phase 3, per the plan's own instruction).
- No gaps. One optional/non-blocking nit raised by the verifier (empty-string
  `MACP_AUTH_JWKS_JSON=""` edge case) — judged already covered by the existing "malformed" wording,
  not worth reopening committed text for.
- Next: Phase 3 (CLAUDE.md `@types/node` fix + full regression pass).

### Phase 3 — DONE (2026-09-23), 2 verify rounds
- Round 1 verdict: **GAPS** (3), fresh Opus verifier (agent `a8d24f6457486371a`):
  1. `CLAUDE.md` is listed by exact name in `.gitignore:13` and was never git-tracked — the phase's
     headline fix would have been silently unshippable. Not a defect introduced this phase; a
     pre-existing repo choice this phase failed to notice and document.
  2. The proposed `@types/node`/CI wording was factually backwards: `.nvmrc` (`20`) *is*
     `engines.node`'s floor, and no CI reconfiguration (matrix, different `typecheck` runtime) could
     ever catch a `@types/node`-vs-floor mismatch, since `tsc` resolves `node:` types from the
     installed package, not the executing Node binary.
  3. Plan bookkeeping (top status line, Phase 3 `Status:` field) was stale — judged acceptable to
     defer to phase-close in round 2 (matches how Phases 1-2 were closed).
- Fixes applied: reworded `CLAUDE.md:109` and the plan's Phase 3 text to state the corrected,
  verified mechanism; added an explicit "Divergence discovered during `/implement`" note documenting
  `CLAUDE.md`'s untracked status (not force-added — respects the repo's existing `.gitignore`
  choice); added a one-sentence Docker port-publish-race caveat to `scripts/e2e-runtime.sh`'s new
  readiness-check comment (verifier's non-blocking suggestion, cheap to include).
- Round 2 verdict: **PASS**, fresh Opus verifier (agent `ac567dfee877b05e2`), all three gaps
  confirmed closed against actual file contents/`git status`, not re-reviewed cold.
- Unplanned files touched, both logged and justified inline (see plan's Phase 3 divergence notes and
  `ASSUMPTIONS.md`): `scripts/e2e-runtime.sh` (readiness-check swapped from reflection-dependent
  `grpcurl ... list` to a plain TCP-connect, after a live run against
  `ghcr.io/multiagentcoordinationprotocol/macp-runtime:latest` — which reports `v0.8.0` at boot, a
  harmless tag lag — found the runtime doesn't expose gRPC reflection); `ASSUMPTIONS.md` (new file,
  one entry, `UNCONFIRMED`, logging that `expect_accept`/`expect_reject` still can't run without
  `-proto`/`-protoset` wiring — real follow-up work, out of this plan's scope, routed to
  `/reconcile`).
- Gates: `npm test` 54/54 (98.18% stmts / 95.55% branch, over threshold), `npm run lint`, `npm run
  typecheck` all green, re-run after every edit in this phase including the gap fixes.
- This was the last phase. Proceeding to finalization (§4) next.

## Finalization — DONE (2026-09-23)

- Whole-feature verdict: **PASS, ship-ready**, fresh Opus verifier (agent `acdf16012901d6ce8`)
  reviewing the cumulative `main..HEAD` diff (4 commits) against the plan as a whole, not
  phase-by-phase. Confirmed: zero production-code drift (`src/config.ts`/`keys.ts`/`server.ts`
  untouched; only 3 comment lines across two `.spec.ts` files), branch green, tree clean,
  `CLAUDE.md`'s untracked status handled honestly, `ASSUMPTIONS.md` is `/reconcile`-actionable.
- 3 non-blocking nits raised, all applied before handoff (not worth a re-verify round — small,
  textual, no behavior change):
  1. `README.md` and `scripts/e2e-runtime.sh`'s "what it proves" header both still implied the e2e
     script fully passes — added a "Known issue" note to both, pointing at `ASSUMPTIONS.md`, so a
     reader doesn't run it expecting success.
  2. Plan review's Round 1 item 6 record read as unresolved once Phase 3 corrected it further —
     annotated with a "Superseded during `/implement` itself" pointer rather than rewritten (keeps
     the historical record of what Round 1 actually caught).
  3. `CHANGELOG.md:57-58`'s historical `@types/node@^20.x` entry was flagged as a "twin" of the
     `CLAUDE.md` staleness Phase 3 fixed — deliberately **not** changed: it's a point-in-time record
     of what was pinned when that entry was written (true then), not a living invariant statement
     like `CLAUDE.md`'s dependency-constraints section, so rewriting it would violate this plan's
     own "don't rewrite historical records" principle from Phase 1.
- Final regression: `npm test` 54/54, `npm run lint` clean, `npm run typecheck` clean, script
  syntax-checked (`bash -n`) after the nit edits.
- Open item carried to `/ship`: Open Question 1 in the plan (file a GitHub issue against
  `macp-runtime` for its own `docs/deployment.md:292` algorithm-allowlist doc bug) — routed to the
  user for a go-ahead, per this session's policy on posting to another repo's public tracker.
- `ASSUMPTIONS.md`'s one entry has since been reconciled (commit `b991cfd`): status is now
  `DEFERRED (precisely scoped 2026-09-23)`, recorded in `DECISIONS.md`, not blocking `/ship`.

## Ship checkpoints

- `/ship`'s fresh verification gate: round 1 **GAPS** (3 minor doc-accuracy items, all fixed in
  commit `3a559dc`); round 2 **PASS**.
- pushed absorb-runtime-v0.8.1 3a559dccd3f821484c1df28aa7ccd3aa4fb3ff28
- PR #30 opened: https://github.com/multiagentcoordinationprotocol/macp-auth-service/pull/30

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

## Follow-up: e2e-runtime.sh auth-probe fix (2026-09-23)

Triggered by macp-runtime issues #186/#187 (filed above) both being fixed upstream via PR #188.
Verified the fix empirically (local `--features reflection` Docker build, macp-runtime repo
untouched) and, in the process, found and fixed an independent pre-existing bug: `expect_accept`/
`expect_reject` probed `Initialize`, which never checks authentication in any version of
macp-runtime — retargeted to `ListSessions`. Full account in `DECISIONS.md`'s 2026-09-23 follow-up
entry and `ASSUMPTIONS.md`'s updated status.

- Verification gate: fresh Opus subagent — **PASS**, 4 documentation-accuracy nits (a stale
  "v0.8.1" characterization of when reflection landed; the same Initialize-anti-pattern in
  `docs/integration.md`; three `file:line` citation nits; one sentence in `ASSUMPTIONS.md` that
  read as re-runnable present tense). All four closed before commit.
- Regression: `npm test` 54/54, `npm run lint` clean, `npm run typecheck` clean, `bash -n` clean.
- Live e2e: `MACP_RUNTIME_IMAGE=macp-runtime-reflection:local scripts/e2e-runtime.sh` — RS256
  accept, garbage-bearer UNAUTHENTICATED reject, ES256 accept, `ALL CHECKS PASSED`. Still fails
  against the default `MACP_RUNTIME_IMAGE` (published image lacks the opt-in reflection feature) —
  documented as the remaining gap, not fixed here.
- pushed fix/e2e-runtime-auth-probe 20f0d7b
- PR #32 opened: https://github.com/multiagentcoordinationprotocol/macp-auth-service/pull/32

## Progress — e2e-runtime-proto-resolution (2026-09-25)

Repo map gathered while writing `plans/e2e-runtime-proto-resolution.md` — see that plan's own
"Repo map" section for the full file/line inventory (`scripts/e2e-runtime.sh`'s existing structure,
`../macp-runtime`'s Cargo/build.rs proto wiring, the schema repo's proto layout and public-repo
status, the sibling Node repo's GitHub-Packages consumption pattern this plan deliberately avoids).
Not duplicated here — `/implement` should read the plan file directly.

**PR strategy:** one PR, single phase. The functional change (proto-based service resolution) and
its doc updates (`README.md`, `docs/integration.md`, `CHANGELOG.md`, `ASSUMPTIONS.md`,
`DECISIONS.md`) are one cohesive, small change with no independent-shippability seam worth
splitting — same reasoning as the `fix/e2e-runtime-auth-probe` PR (#32) that preceded it.

**Branch:** `fix/e2e-runtime-proto-resolution`.

### Phase 1 (only phase) — 2026-09-25

- Verification gate: fresh Opus subagent (not the executor's context), given the plan's Phase 1
  section, the staged diff, and the live test output. **PASS** on round 1 — all 9 acceptance
  criteria independently re-run and confirmed by the verifier itself (not just trusted from the
  implementer's transcript), all 6 of the plan's own review-round fixes confirmed actually landed
  in the file content, `shellcheck` clean, quoting verified safe including space-containing paths.
  One non-blocking finding: `MACP_PROTO_VERSION` was unsanitized before use in the fetch URL,
  letting `curl`'s path normalization redirect the fetch to an arbitrary repo/ref. Closed
  immediately (see `plans/e2e-runtime-proto-resolution.md`'s Phase 1 status note and
  `DECISIONS.md`'s addendum) rather than deferred, since the fix was one line and had zero risk to
  the passing paths — verified live both ways after the fix.
- Regression: `npm run lint`, `npm run typecheck`, `npm test` (54/54) green, both before and after
  the post-verification hardening fix.
- Live e2e, all four resolution tiers run for real against the actual default published
  `ghcr.io/multiagentcoordinationprotocol/macp-runtime:latest` image (no local build, no Cargo
  feature): default/sibling-checkout path, `MACP_PROTO_SKIP_SIBLING=1` (network-fetch path, temp-dir
  cleanup confirmed), `MACP_PROTO_DIR` override (complete dir), `MACP_PROTO_DIR` override (missing
  file → fast named failure) — all as specified in acceptance criteria 2-4, 8-9.
- Finalization (`/implement` §4): this is a one-phase feature, so the phase-1 gate above already
  covers the whole diff; no additional integration seam exists between phases to test separately.
  Docs (`README.md`, `docs/integration.md`, `CHANGELOG.md`) and tracked files
  (`ASSUMPTIONS.md`, `DECISIONS.md`, this file, the plan itself) are all updated in this same
  commit — no separate finalization commit needed.
- Files touched: `scripts/e2e-runtime.sh`, `README.md`, `docs/integration.md`, `CHANGELOG.md`,
  `ASSUMPTIONS.md`, `DECISIONS.md`, `plans/e2e-runtime-proto-resolution.md`, `PROGRESS.md`.
- What's next: commit, then `/ship` (push, PR, CI watch, squash-merge).
