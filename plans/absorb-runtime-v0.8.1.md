# Plan: re-verify auth-service against macp-runtime v0.8.1 (+ control-plane 0.3.0, sdk-ts 0.11.0, sdk-py 0.9.1)

Status: DONE (all 3 phases complete)
Owner: auth-service maintainers
Scope: this repo only (`auth-service`). No code changes to any sibling repo are proposed here.
Ground truth verified against (all as siblings under `/Users/Shared/multiagentcoordinationprotocol/`):
`../macp-runtime` @ `2ce6480` (CHANGELOG `[0.8.1]`), `../macp-control-plane` @ `ab4e6b0` (v0.3.0),
`../macp-sdk-typescript` @ `001bf73` (v0.11.0), `../macp-sdk-python` @ `dad86b4` (v0.9.1).

---

## Context

The last cross-repo absorb pass (`plans/absorb-runtime-v0.5.0.md`, fully executed — see its T1–T7
land in `CLAUDE.md`, `src/contract.spec.ts`, `src/keys.spec.ts`, `scripts/e2e-runtime.sh`, and the
`docs/` rotation/latency/config-surface guidance it produced) pinned auth-service's contract to
**macp-runtime v0.5.0** specifically. All four sibling repos have since shipped substantial work:
runtime went v0.5.0 → v0.8.1 (mode-registry parity-contract consumer, handoff `semantics_rev` 2,
policy `schema_version` 2→3), control-plane went to v0.3.0 (admin runtime-session-drift endpoint,
absorb-runtime-v0.8.0 phases 1–7), and both SDKs bumped minor versions with their own `schema_version`
3 breaking changes.

A four-way parallel investigation (one Opus agent per sibling repo, each reading the actual current
source — not changelogs alone) found **zero functional or wire-contract drift**:

- **macp-runtime** (`crates/macp-auth/src/auth/resolvers/jwt_bearer.rs:8-27`): `MACPClaims` /
  `MACPScopes` are byte-for-byte identical to the v0.5.0 shape auth-service pins in
  `src/contract.spec.ts`. The default JWT alg allowlist (`RS256,ES256`), `kid`-based O(1) key
  selection, the `STALE_GRACE = 3600s` stale-cache window, and the `MACP_ALLOW_INSECURE` startup
  gate are all unchanged (`security.rs:268-331`, `jwt_bearer.rs:64,156,274-299`, `main.rs:422-443`).
  The only `!`-marked (breaking) commit since 0.5.0, `7c652b6`, touches handoff sweep logic in
  `src/main.rs` and never touches `crates/macp-auth`. `jsonwebtoken` is still pinned at 9.3.1.
- **macp-control-plane** (`src/runtime/runtime-jwt-minter.service.ts:66-99`): still sends exactly
  `{ sender, ttl_seconds, scopes: { can_start_sessions, is_observer, can_manage_mode_registry? } }`
  and reads exactly `{ token, expires_in_seconds }` — a strict subset of auth-service's `MintScopes`
  / `MintResponseBody` (`src/server.ts:6-25`). Its new admin drift-detection endpoint (Phase 7,
  PR #87) reuses the existing observer-scoped JWT rather than requiring a new scope.
- **macp-sdk-typescript** and **macp-sdk-python**: both are pure bearer consumers that treat the
  minted JWT as opaque — neither parses `macp_scopes` — so there is no scope-shape coupling to drift.
  Their `Auth.bearer` / `AuthConfig.for_bearer` APIs and `expectedSender` guards are unchanged. The
  TS SDK's "Node 20 CI drop" (`a8e7064`) only trimmed its GitHub Actions matrix; its published
  `engines.node` floor is still `>=20`.

**What this means for scope:** this is a re-verification and doc-currency pass, not a compatibility
fix. No production code changes are required anywhere in `src/`. The residual work is (1) re-pinning
the handful of places that name an *exact* verified-against runtime version rather than a floor
(`≥0.5.0`), (2) documenting two footguns the investigation surfaced that the v0.5.0 pass did not
know about, and (3) an incidental doc-accuracy fix in `CLAUDE.md` unrelated to the siblings. Where
the prior plan already phrased guidance as a floor ("runtime ≥ 0.5.0"), that text remains correct at
0.8.1 and is deliberately left untouched.

---

## Phases

### Phase 1 — Re-pin the exact verified-against runtime version (v0.5.0 → v0.8.1)

**Status:** DONE — implemented exactly as planned, no divergence. Verified by a fresh Opus agent
(PASS, round 1): all five files match the Files list, `scripts/e2e-runtime.sh:17` and the
`>= 0.5.0` floor lines were correctly left untouched, `npm test`/`lint`/`typecheck` all green.

**Delivers:** every place that asserts an *exact* runtime version as the one this service's contract
was last verified against says v0.8.1, backed by the citations gathered in this plan's Context —
not a re-guess, a re-verification. Floor-style claims (`runtime ≥ 0.5.0`) are left alone since 0.8.1
still satisfies them and rewriting them adds no information.

**Depends on:** none.

**Files:**
- `src/contract.spec.ts:7-29` — header comment: `"Verified against macp-runtime v0.5.0 (...)"` →
  `v0.8.1`, keeping the `jsonwebtoken 9.3.x` note (still 9.3.1) and the "runtime's default
  `MACP_AUTH_JWT_ALGS` allowlist ... as of v0.5.0" phrase → `v0.8.1`.
- `src/keys.spec.ts:6` — comment `"Runtime v0.5.0 selects the verifying key..."` → `v0.8.1`.
- `README.md:156` — `"a real macp-runtime v0.5.0 container"` → `v0.8.1`.
- `scripts/e2e-runtime.sh:4` — header comment naming `v0.5.0` as the verifier under test →
  `v0.8.1`. Leave line 11 and line 24 (`>= 0.5.0` floor phrasing) **and** line 17 untouched: line
  17's `"(the v0.5.0 gate change)"` is a provenance claim about when the runtime's dev-mode gate
  shipped, not a verified-against pin — it is correct forever and re-pinning it to v0.8.1 would
  make it factually false.
- `CHANGELOG.md` — add a new `[Unreleased] > Changed` entry: "Re-verified against macp-runtime
  v0.8.1, macp-control-plane v0.3.0, macp-sdk-typescript v0.11.0, and macp-sdk-python v0.9.1 — no
  wire-contract or behavior drift found; see `plans/absorb-runtime-v0.8.1.md`."

**Approach:** a straight re-pin, not a rewrite — every fact these comments assert (struct shape,
allowlist, `kid` behavior) was independently re-confirmed against the current sibling source in this
plan's Context, so the edit is "same claim, current version number," never a guess forward from the
old text. This is the same low-risk pattern `plans/absorb-runtime-v0.5.0.md`'s T4 used successfully.

**Edge cases & failure modes:** none — these are comments and a markdown line; nothing here changes
run-time behavior. The only failure mode is human: re-pinning a version number *without* having
actually re-verified the claim next to it, which is why Context above cites file:line for each one
rather than asserting "should still be fine."

**Acceptance criteria:**
- `grep -rn "v0\.5\.0" src/ README.md scripts/` returns exactly one hit —
  `scripts/e2e-runtime.sh:17`'s `"the v0.5.0 gate change"` provenance parenthetical, which stays
  forever and is not a target of this phase. (CHANGELOG.md's historical `[Unreleased]` entry from
  the prior pass and `plans/absorb-runtime-v0.5.0.md` are separately exempt for the same reason —
  historical record, not rewritten.)
- `grep -rn "v0\.8\.1" src/contract.spec.ts src/keys.spec.ts README.md scripts/e2e-runtime.sh` finds
  the new pins.
- `npm test` still green (comment-only changes in `.spec.ts` files; no assertion text changes).

**Tests:** none new — `npm test` re-run as a regression check that touching comment lines in
`contract.spec.ts` / `keys.spec.ts` didn't accidentally clip an assertion.

**Docs:** `CHANGELOG.md` (in this phase, as listed above).

---

### Phase 2 — Document two integration footguns surfaced by the re-verification

**Status:** DONE — implemented exactly as planned, no divergence. Verified by a fresh Opus agent
(PASS, round 1): both docs edits landed at the correct locations with accurate content (checked
against the runtime's actual precedence/error-handling code), the operations.md subsection matches
the section's existing format, the integration.md table stayed valid, and the baseline suite stayed
green. One optional nit was raised (empty-string `MACP_AUTH_JWKS_JSON=""` is arguably already
covered by "malformed") and judged non-blocking, not acted on.

**Delivers:** two operational risks the v0.5.0 pass didn't know about are now written down where an
operator integrating auth-service with a runtime would actually look.

**Depends on:** none (independent of Phase 1; both touch `docs/` only).

**Files:**
- `docs/integration.md` — two edits:
  1. **Runtime wiring** section (lines 221-242): add a new prose paragraph after the existing
     "Dev-mode note" paragraph (after line 241 — as prose, not inside the fenced `bash` block at
     225-234): the runtime checks `MACP_AUTH_JWKS_JSON` (inline JWKS) **before**
     `MACP_AUTH_JWKS_URL` (`../macp-runtime/crates/macp-auth/src/security.rs:322` vs `:331`) — if
     an operator sets both, the runtime silently never fetches auth-service's live JWKS endpoint,
     so a key rotation has no effect until the inline value is updated too. Worse: if
     `MACP_AUTH_JWKS_JSON` is set but malformed, the runtime logs an error and registers **no** JWT
     resolver at all — the `else if` branch for `MACP_AUTH_JWKS_URL` never runs as a fallback
     (`security.rs:322-338`) — which can silently disable JWT authentication entirely. Prefer
     `MACP_AUTH_JWKS_URL` alone in any deployment that rotates keys.
  2. **Scopes model** table (line 395): `can_manage_mode_registry`'s description is incomplete —
     it currently reads "May register/unregister/promote extension modes." The runtime also gates
     `RegisterPolicy`/`UnregisterPolicy` on this same scope (`../macp-runtime/src/server.rs:1611,1645`;
     control-plane's own client code names both RPCs under this scope,
     `../macp-control-plane/src/runtime/runtime-jwt-minter.service.ts:79`). Reword to "May
     register/unregister/promote extension modes, and register/unregister policies
     (`RegisterPolicy`/`UnregisterPolicy`)."
- `docs/operations.md` — "Common failures" (lines 138-190) is six `###` subsections with bullet
  bodies (140, 147, 155, 163, 176, 182), **not a table**. Add a seventh: heading "### Runtime keeps
  accepting a rotated-out key indefinitely, or doesn't seem to enforce JWT auth at all", body:
  check whether the runtime has `MACP_AUTH_JWKS_JSON` set — if so, it takes precedence over
  `MACP_AUTH_JWKS_URL` and freezes the key set at whatever was baked into that env var, so rotation
  via the live endpoint has no effect until it's updated or removed; and if `MACP_AUTH_JWKS_JSON`
  is malformed, the runtime registers no JWT resolver at all rather than falling back to the URL —
  check the runtime's startup logs for a JWKS-parse error whenever tokens minted here aren't being
  verified as expected.

**Approach:** document defensively rather than trying to change runtime behavior — auth-service does
not own `MACP_AUTH_JWKS_JSON`'s precedence or the runtime's scope-to-RPC mapping, and both fixes
belong in the runtime's own configuration/docs, not in this service's code. Placing the failure mode
in "Common failures" (operations.md) matches where an on-call engineer would actually be looking
mid-incident, and in "Runtime wiring" (integration.md) matches where a new integrator sets env vars
for the first time — both surfaces, since the risk is silent (no error, no log line on auth-service's
side) and the two audiences read different docs. The Scopes-model correction is a plain accuracy fix:
the table under-describes what the scope it documents actually gates.

**Edge cases & failure modes:** the JWKS-precedence and malformed-JSON failures this documents *are*
the edge cases — an operator who sets both env vars, or typos the inline JSON, gets no warning from
either service. auth-service cannot detect either from its side (it has no visibility into the
runtime's env or logs). No code fix exists on this side of the boundary; the mitigation is entirely
"tell people before they hit it."

**Acceptance criteria:**
- `docs/integration.md`'s Runtime wiring section explicitly mentions `MACP_AUTH_JWKS_JSON`, its
  precedence over `MACP_AUTH_JWKS_URL`, and the malformed-inline-JWKS no-fallback case.
- `docs/integration.md`'s Scopes model table describes `can_manage_mode_registry` as covering both
  mode registration and policy registration/unregistration.
- `docs/operations.md`'s Common failures section has a seventh `###` subsection, consistent in
  format with the existing six.
- A fresh reader of either doc, given a runtime that "won't pick up a rotated key" or "isn't
  enforcing JWT auth at all," would find the cause without needing to read the runtime's own
  source.

**Tests:** none (documentation only, no assertable behavior in this repo).

**Docs:** this phase *is* the docs change — `docs/integration.md`, `docs/operations.md`.

---

### Phase 3 — Fix the incidental `CLAUDE.md` dependency-doc drift; full regression pass

**Status:** DONE — implemented with two rounds of verification. Round 1: **GAPS** (3) — `CLAUDE.md`'s
gitignored status went undiscussed, the `@types/node`/CI reasoning was factually backwards (`.nvmrc`
*is* the floor; no Node-version CI change could catch a `tsc`/`@types/node` mismatch anyway), and
plan bookkeeping was stale. All three fixed (see the divergence notes inline above and in
`ASSUMPTIONS.md`); round 2: **PASS**, fresh Opus agent, all three confirmed closed against the actual
file contents and `git status`, suite still green (54/54, coverage over threshold, lint/typecheck
clean). Net divergence from the original plan: (a) `CLAUDE.md`'s fix is real but untrackable by git —
documented, not force-committed; (b) the `@types/node` risk statement was rewritten to the
factually-correct mechanism, not the plan's first draft; (c) two unplanned files touched —
`scripts/e2e-runtime.sh` (readiness-check fix) and `ASSUMPTIONS.md` (new) — while attempting the
best-effort live e2e run, which surfaced a real, separate, out-of-scope issue (runtime image lacks
gRPC reflection) logged as `UNCONFIRMED` rather than silently expanded into.

**Delivers:** `CLAUDE.md`'s dependency-constraints section stops asserting a specific `@types/node`
range that goes stale on every Dependabot bump, and the whole suite (lint, typecheck, test with
coverage thresholds) is re-confirmed green with zero `src/` diffs — the concrete evidence that this
pass is documentation-only.

**Depends on:** none (independent of Phases 1–2; can land in parallel or last).

**Files:**
- `CLAUDE.md:109` (Dependency constraints section) — current line: `` **`@types/node@^20.x`** —
  Matches `engines.node >= 20`. `` is stale: `package.json:45` actually pins
  `` "@types/node": "^26.4.0" `` (confirmed via the sibling-SDK audit, which independently found the
  identical pattern — `@types/node` tracking well ahead of the `engines.node` floor — in
  `macp-sdk-typescript` too, so this is an ecosystem-wide Dependabot behavior, not a local mistake).
  The naive fix ("kept at or above the floor") would state a false safety guarantee: `@types/node`
  pinned *above* the floor is the unsafe direction, not the safe one — it lets `tsc` typecheck
  against `node:`-builtin APIs from Node 26 that don't exist on the `engines.node >= 20` floor this
  service claims to support. **Correction made during `/implement` (Phase 3's fresh-verifier pass
  caught this):** the plan's first draft additionally claimed CI doesn't catch this because
  `typecheck` runs only on `.nvmrc`'s version, "not the `engines` floor" — that's factually wrong:
  `.nvmrc` is `20`, which *is* the floor (`.github/workflows/ci.yml:23,34`; confirmed by reading the
  file, not assumed). The real reason no CI configuration can catch this is more fundamental and
  version-independent: `tsc`'s view of `node:` APIs comes entirely from the installed `@types/node`
  package, not from whichever Node binary executes `tsc` — so running `typecheck` under Node 20
  instead of Node 26 changes nothing about what `tsc` accepts. Reword to name the real risk
  correctly: `` **`@types/node`** — Dependabot keeps this ahead of the `engines.node` floor
  (`>=20`); normal for a devDependency, but it means `tsc` type-checks against `node:`-builtin
  declarations that may not exist on Node 20. No CI job can catch this by running on a different
  Node version: `tsc`'s view of `node:` APIs comes entirely from the installed `@types/node`
  package, not from whichever Node binary happens to execute `tsc` — so `typecheck` running on
  `.nvmrc`'s Node 20 (which does match the `engines` floor) type-checks against Node 26 declarations
  regardless. If a change relies on a recent Node builtin, verify by hand that it actually exists on
  Node 20. ``
- No CI/workflow changes are proposed: per the corrected understanding above, no CI configuration
  (running `typecheck` on a different Node version, adding it to the matrix, etc.) could actually
  catch this risk, since `tsc`'s `node:` type view is tied to the installed `@types/node` package,
  not to the Node binary running `tsc`. The reworded `CLAUDE.md` line is the only mitigation this
  plan proposes — a durable warning for the next contributor, not a CI fix that doesn't exist.
- Two more files ended up touched during this phase's verification work (below), beyond the original
  plan — see each one's divergence note: `scripts/e2e-runtime.sh` (readiness-check fix) and
  `ASSUMPTIONS.md` (new file, logging the e2e finding this phase couldn't fully resolve).

**Approach:** fix the *invariant*, not the *snapshot* — CLAUDE.md exists to describe conventions that
outlive individual dependency bumps (see the file's own framing), so a hardcoded minor-version range
for a devDependency that Dependabot actively bumps is a doc that is guaranteed to drift again. But the
invariant must be the *true* one: the reviewer pass caught that "stay at or above the floor" is
backwards for a types package (above-floor is the risky direction, not the safe one), so the reworded
line states the actual risk and the actual CI gap instead of a comforting but false guarantee. This
mirrors how the file already documents the *real* invariant for `jose` (pinned intentionally, with a
stated reason) rather than just a version number.

**Edge cases & failure modes:** none functionally — this is a wording fix plus a read-only test run.
The only risk is scope creep (e.g. "while we're in here, let's also bump `@types/node`'s declared
range in `package.json`") — explicitly out of scope: `package.json` is not touched by this plan, and
no dependency version changes anywhere in this repo.

**Divergence discovered during `/implement` (Phase 3's fresh-verifier pass caught this):**
`CLAUDE.md` is listed by name in this repo's own `.gitignore:13` and has never been a tracked file
(`git log -- CLAUDE.md` is empty; `git ls-files` doesn't list it) — despite the harness generally
treating `CLAUDE.md` as "project instructions checked into the codebase." This appears to be a
deliberate repo choice (the file is excluded by exact name, not an accidental wildcard match), not
something introduced by this plan, so this phase does not change `.gitignore` — that's a repo-policy
call for a human to make, not an implementation detail to fix silently mid-phase. Practical effect:
the corrected `@types/node` wording below is real and takes effect for any Claude Code session
reading this repo locally, but it **cannot appear in `git diff`, this phase's commit, or the PR** —
there is nothing to `git add`. The acceptance criteria below are phrased accordingly (verified by
reading the file's current content, not by a `git diff`).

**Acceptance criteria:**
- `CLAUDE.md`'s dependency-constraints section, read directly from disk, no longer states a specific
  `@types/node` minor/patch range and no longer implies a nonexistent CI mitigation; it states the
  real, version-independent risk instead. (Not visible in `git diff` — see the divergence note above.)
- `npm run lint`, `npm run typecheck`, and `npm test -- --coverage` (or `npm run test:coverage`) all
  pass with the existing coverage thresholds in `jest.config.js`. `git diff --stat -- src/` across
  all three phases shows changes only to comment lines in `src/contract.spec.ts` and
  `src/keys.spec.ts` (Phase 1's version re-pin) — no other `src/**/*.ts` production-code changes
  anywhere in the plan, confirming the whole pass is a version-pin and documentation refresh.
- If Docker and a runnable `macp-runtime` v0.8.1 binary/image are available locally,
  `scripts/e2e-runtime.sh` is re-run once against it as the strongest available confirmation (it
  exercises the real Rust verifier end-to-end, not just the offline contract pin) — this is best-effort
  given it depends on local environment availability, not a hard gate on the phase. **Divergence
  (see Phase 3's closing note): the live run surfaced that the script's grpcurl calls depend on gRPC
  server reflection, which the current published runtime image does not expose — a pre-existing issue
  unrelated to this plan's scope, not something this phase attempts to fully fix.**

**Tests:** `npm run lint`, `npm run typecheck`, `npm test -- --coverage`; optionally
`scripts/e2e-runtime.sh` against a live runtime 0.8.1 instance.

**Docs:** `CLAUDE.md` (as listed above).

---

## Long-term posture

No one-way doors here — every change in this plan is a comment, a markdown line, or a re-run of the
existing test suite. The one deliberate long-term choice is in Phase 3: fixing `CLAUDE.md`'s
`@types/node` line to state an invariant instead of a snapshot trades a small amount of specificity
for not needing this exact fix again next quarter. If a future contributor wants CLAUDE.md to pin an
exact `@types/node` range again (e.g. because a specific version introduced a real incompatibility),
that's a new, deliberate decision — not a default to restore silently.

## Enterprise concerns

None apply beyond the normal bar: this plan introduces no new scale, reliability, security, or
observability surface. The nearest thing to an observability concern — the silent
`MACP_AUTH_JWKS_JSON`-precedence footgun in Phase 2 — is exactly why it's being documented in
`docs/operations.md`'s failure-mode table rather than left for the next on-call engineer to
rediscover during an incident.

## Open questions

1. **Should we file a GitHub issue against `macp-runtime` for its own doc bug?** The runtime's
   `docs/deployment.md:292` still states "Supported algorithms: RS256, ES256, HS256" with no opt-in
   caveat — inconsistent with its own code (`security.rs:295-316`, HS256 only via explicit
   `MACP_AUTH_JWT_ALGS` opt-in) and its own CHANGELOG. This was already flagged as a cross-repo note
   in `plans/absorb-runtime-v0.5.0.md`'s risk section two releases ago and is still present at
   v0.8.1, so raising it now (rather than re-discovering it at the next absorb pass) is the right
   call on the merits — filing a GitHub issue is a low-cost, easily-reversible ask. **This is
   routed to you rather than auto-filed**, because posting to another repo's public issue tracker is
   an action visible to others and outside this repo's own scope, not because the technical judgment
   is unclear. Recommendation: file it, linking to `../macp-runtime/docs/deployment.md:292` and
   `security.rs:295-316`, once this plan lands. Say the word and I'll open it.
2. **The `MACP_AUTH_JWKS_JSON`-precedence footgun (Phase 2)** — decided without escalation: document
   defensively on our side only, do not ask the runtime team to change the precedence behavior
   itself (setting inline JWKS is a legitimate air-gapped-deployment feature; the interaction with a
   simultaneously-set URL is the operator's configuration error to avoid, not a runtime bug to fix).
3. No `UNCONFIRMED` items are anticipated for `/reconcile` — every claim in this plan traces to a
   file:line read this session, across four sibling repos. (Superseded by item 4 below, logged
   during Phase 3's live verification attempt.)
4. **`scripts/e2e-runtime.sh` no longer completes end-to-end.** A live run against
   `ghcr.io/multiagentcoordinationprotocol/macp-runtime:latest` (which reports `v0.8.0` at boot,
   not `v0.8.1` — the published `:latest` tag lags the source repo's release commit; immaterial to
   this plan since the diff between the two tags touches no `crates/macp-auth` file) found that
   grpcurl's calls — both the readiness check (`grpcurl ... list`) and the functional calls in
   `expect_accept`/`expect_reject` — depend on gRPC server reflection, which this runtime build does
   not expose (`"server does not support the reflection API"`). This phase fixed the readiness
   check (now a plain TCP-connect, correct regardless of reflection support) but did **not** fix
   `expect_accept`/`expect_reject`, since doing so needs `grpcurl -proto`/`-protoset` wired to the
   actual `macp-proto` service definitions — real, separate engineering work (locating/vendoring the
   right `.proto`, keeping it version-synced, verifying method signatures), not a docs-refresh task.
   Logged to `ASSUMPTIONS.md` as `UNCONFIRMED` for `/reconcile` to route: is reflection's removal
   from the runtime intentional (→ file an issue asking for it back, since it's a reasonable
   dev/debug affordance) or is this repo's script now expected to carry its own `.proto` (→ a real,
   separate follow-up task)? Either way, **not a blocker** — the offline `src/contract.spec.ts` wire
   contract pin is unaffected and remains the load-bearing verification.

## Repo map

Saved to `PROGRESS.md` alongside this plan.

## Plan review

**Round 1 — REVISE.** A fresh Opus agent (no context from drafting) re-read every cited file:line
against the actual current code in all four sibling repos, independently re-confirmed the core
premise (zero wire-contract drift — including a targeted check that the runtime's mode-registry
parity-contract and policy `schema_version` 2→3 work never touches `AuthIdentity`/`macp_scopes`
validation semantics), and found eight defects in the plan's own text:
1. `scripts/e2e-runtime.sh:17` misclassified as an exact-version pin (it's a provenance claim,
   "the v0.5.0 gate change," that must stay unchanged) — **fixed** in Phase 1's Files/acceptance.
2. Phase 1's acceptance grep would never pass because of (1) — **fixed**, now expects exactly one
   surviving hit.
3. Phase 2 described `docs/operations.md`'s "Common failures" as a table with five rows; it is six
   `###` subsections — **fixed**, Phase 2 now adds a seventh subsection in the right format.
4. Phase 2's `docs/integration.md` insertion point pointed inside a fenced `bash` block — **fixed**,
   now a new prose paragraph after line 241.
5. Phase 3's acceptance claimed `git diff --stat -- src/` would show zero lines changed, contradicting
   Phase 1's own comment edits in two `.spec.ts` files — **fixed**, acceptance now states the accurate
   bound.
6. Phase 3's proposed `CLAUDE.md` wording ("kept at or above the floor") stated the invariant
   backwards — pinning `@types/node` *above* `engines.node`'s floor is the risky direction (untyped
   Node-26-only APIs slip past `tsc`), and the reviewer additionally found CI's `typecheck` job never
   runs against the Node 20/22 matrix, so the gap is real and uncaught today — **fixed**, Phase 3 now
   names the actual risk and the CI gap instead of a false safety claim.
7. **Missing:** `docs/integration.md:395`'s `can_manage_mode_registry` description omitted that the
   runtime also gates `RegisterPolicy`/`UnregisterPolicy` on the same scope — **added** to Phase 2.
8. **Missing:** a malformed `MACP_AUTH_JWKS_JSON` makes the runtime register no JWT resolver at all
   (no fallback to `MACP_AUTH_JWKS_URL`), which can silently disable JWT auth entirely — **added** to
   Phase 2 alongside the precedence footgun, since both live in the same runtime code path
   (`security.rs:322-338`) and the same operator-facing docs sections.
Two cosmetic citation-range corrections (`contract.spec.ts:10-30` → `7-29`, `server.ts:7-24` →
`6-25`) were also applied.

All eight defects plus both cosmetic fixes were applied directly to this plan file above. No change
altered the plan's phase count, dependencies, or bottom-line scope (still zero production-code
changes) — every fix tightened an existing phase's Files/Approach/Acceptance criteria to match the
code precisely.

**Round 2:** not required — every Round 1 finding was a scoped, mechanical correction (wrong line
number, wrong insertion point, wrong acceptance text, one backwards technical claim), not a
structural or scope question that would need re-litigating. Per the plan skill's two-round cap and
its guidance to re-review only what changed, a full second adversarial pass over unchanged
sections would re-verify facts already independently confirmed in Round 1 (the core "zero drift"
premise) without new risk surface to check. Handing off to `/implement` now.
