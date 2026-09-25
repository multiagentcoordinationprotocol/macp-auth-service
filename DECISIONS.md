# Decisions

Durable record of `/reconcile` outcomes. Append-only, one entry per reconciled assumption.

## 2026-09-23 — e2e-runtime.sh's grpcurl calls depend on reflection the runtime doesn't expose

- **Plan:** plans/absorb-runtime-v0.8.1.md
- **Original assumption** (`ASSUMPTIONS.md`, logged during `/implement`): the runtime's missing
  gRPC reflection support was of unknown origin — possibly a deliberate hardening choice (→ file an
  issue asking for it back) or possibly something this repo's own script should route around by
  vendoring a `.proto` file (→ real, loosely-scoped follow-up work).
- **Analysis** (fresh Opus subagent, low blast radius per the Autonomy ladder — opt-in dev script,
  not wired into CI, no production impact, offline `contract.spec.ts` pin unaffected either way):
  - `grep -rni reflection` across the entire `macp-runtime` repo (excluding `target/`/`.git/`)
    returns **zero hits**. No `tonic-reflection` dependency in `Cargo.toml:45-49`; the server
    registers exactly two services, health + runtime (`src/main.rs:491,519-524`).
  - `git log --all -S "reflection"` / `-S "tonic-reflection"` / `-S "tonic_reflection"` — **zero
    commits**. Reflection was never added, so it was never removed either — there is no security
    rationale, no `SECURITY.md`/`CHANGELOG.md` entry, nothing to point an issue at as a regression.
  - No env var, CLI flag, or Cargo feature gates it (39-variable `MACP_*` surface enumerated, none
    reflection-related; `[features]` in `Cargo.toml:71-75` has no debug/reflection profile; the
    Dockerfile does a bare `cargo build --release` with no build-args).
  - The originally-assumed cost of the local fix was **overstated**: the real proto definitions are
    already published as npm `@multiagentcoordinationprotocol/proto` (and crates.io `macp-proto`
    0.1.10), with `MACPRuntimeService`/`Initialize` at
    `multiagentcoordinationprotocol/schemas/proto/macp/v1/core.proto:457`. Adding that package as a
    devDependency and passing `grpcurl -import-path … -proto macp/v1/core.proto` needs no vendoring
    and stays version-synced by construction — this is a substantially smaller task than
    "vendor and hand-maintain a `.proto` file," which is what the original assumption anticipated.
- **Decided by:** Opus (this `/reconcile` pass), not escalated — genuinely low blast radius: an
  opt-in, non-CI dev script; the offline wire-contract test that actually gates correctness is
  untouched by any of this.
- **Verdict:**
  1. **Filing a GitHub issue against `macp-runtime`** asking for reflection support is reasonable
     (it's a plausible, low-cost dev/debug affordance many teams add, and there's no hardening
     reason not to) — but it's a **nice-to-have, not an unblock**, since the real fix doesn't depend
     on it. **Filed 2026-09-23**, after the session owner's go-ahead (batched with the plan's
     separate Open Question 1, the `docs/deployment.md:292` doc-bug issue):
     https://github.com/multiagentcoordinationprotocol/macp-runtime/issues/187.
  2. **The local fix is a well-scoped, deferred follow-up**, not done in this pass: it means adding
     a new devDependency (`@multiagentcoordinationprotocol/proto`) and rewriting
     `expect_accept`/`expect_reject`'s `grpcurl` invocations in `scripts/e2e-runtime.sh` to pass
     `-import-path`/`-proto`, then re-running the live e2e script to confirm it completes end to end
     — real, testable implementation work with its own verification cycle, not a "small and safe"
     edit to wave through inside `/reconcile`. Precisely scoping it here is this pass's actual
     contribution: the next person (or the next `/implement` run) doesn't need to re-derive any of
     the investigation above.
- **Status:** `ASSUMPTIONS.md`'s entry updated to `DEFERRED (precisely scoped 2026-09-23)` — no
  longer a vague "real, separate engineering work," but not resolved either. Revisit next time
  someone needs a working live e2e run, or as a standalone small feature.

## 2026-09-23 — Follow-up: macp-runtime reflection landed, e2e script fixed and verified

- **Trigger:** the session owner reported `macp-runtime` issues #186 (doc bug) and #187
  (reflection nice-to-have, filed above) both fixed. Verified rather than trusted: both issues
  show `CLOSED`; the closing PR is `macp-runtime` #188, commit `1d0b2a7579264b63b6f2f2e7887ca9ae55e3cb9a`,
  merged 2026-09-23T17:29:45Z. Read its full diff — the doc fix corrects the JWT algorithm allowlist
  wording in `docs/deployment.md`/`README.md`, and reflection is added via `tonic-reflection` behind
  a new, non-default `reflection` Cargo feature (opt-in `build.rs`/`src/main.rs`/`Cargo.toml` changes,
  a new `tests/reflection.rs`, a feature-gated CI job) — never in the published Docker image, per the
  PR's own description and a check of its `Dockerfile` (bare `cargo build --release`, no build-args).
- **Empirical verification, not just trusting the PR description:** native `cargo build --features
  reflection` failed locally on an unrelated macOS SDK/linker issue (`tapi error`, arm64e.x1-macos in
  a `MacOSX27.0.sdk`) — not caused by the code. Built via Docker instead: a temporary
  `Dockerfile.reflection` written to this session's scratchpad (never inside `macp-runtime` — that
  repo was never modified) adds `--features reflection` to the build step, using `macp-runtime` only
  as build context. Ran `MACP_RUNTIME_IMAGE=macp-runtime-reflection:local scripts/e2e-runtime.sh`
  against the result.
- **First run:** got past the old reflection error entirely, confirming the fix is real, but hit a
  new one: `INVALID_REQUEST: supported_protocol_versions must not be empty` — `Initialize`'s request
  proto (`message InitializeRequest` at `core.proto:72`) requires it, and `macp-core::MACP_VERSION`
  is `"1.0"`. Traced and about to patch the request body when a second look at the handler
  (`src/server.rs:792-857`) showed
  `initialize()` never calls `authenticate_metadata` at all, in this build or (per a full git-history
  check of `src/server.rs`) any prior one. **`expect_accept`/`expect_reject` had been probing the
  wrong RPC from the start** — one that would accept any bearer regardless of validity — so even a
  hypothetical past run that got past the reflection error could never actually have proven RS256/
  ES256 acceptance or garbage-bearer rejection. This predates and is independent of the reflection
  gap; it was simply never reachable until reflection started resolving the service.
- **Fix:** retargeted both `expect_accept` and `expect_reject` in `scripts/e2e-runtime.sh` to
  `ListSessions`, which checks `authenticate_metadata` as its first statement, before request-shape
  validation (`src/server.rs:1274-1278`, preceded by a comment at `:1271-1273` confirming this
  ordering is deliberate), and
  takes an all-optional request (`{}` is valid). Re-ran: `PASS: RS256 token accepted`, `PASS: garbage
  bearer rejected with UNAUTHENTICATED`, `PASS: ES256 token accepted`, `ALL CHECKS PASSED`.
- **What's still open:** the published `ghcr.io/multiagentcoordinationprotocol/macp-runtime:latest`
  image still lacks the `reflection` feature (it's opt-in, not default), so `scripts/e2e-runtime.sh`
  run with its default `MACP_RUNTIME_IMAGE` still fails at that step — only a locally-built
  `--features reflection` runtime (or a local binary via `MACP_RUNTIME_BIN`) gets a fully-automated
  pass today. Wiring `-proto`/`-protoset` against the published `macp-proto` schema so the default
  image works too remains the deferred follow-up named in the entry above — not done in this pass,
  still bigger than a script fix.
- **Decided by:** Opus, not escalated — reversible, opt-in dev-script-only change; no production
  code touched; the offline `src/contract.spec.ts` wire-shape pin is unaffected either way.
- **Status:** `ASSUMPTIONS.md`'s entry updated to `RESOLVED-UPSTREAM, LOCAL-FIX-VERIFIED
  (2026-09-23)`. Local-only full pass confirmed; default-image full pass remains future work.

## 2026-09-25 — Close the deferred follow-up: stop depending on reflection at all

- **Plan:** `plans/e2e-runtime-proto-resolution.md`
- **Trigger:** the session owner asked whether any pending tasks/plans/issues remained; the
  default-image gap tracked above (2026-09-23 entry) was the one real item found. Ran a full
  `/plan` → review → `/implement` cycle rather than a quick patch, since the fix touches how the
  script sources a versioned external schema — worth getting right once.
- **Correction to the prior entry's claim:** the 2026-09-23 entry above states the proto
  definitions are "already published as npm `@multiagentcoordinationprotocol/proto`," which reads
  as the public npm registry. Checked directly: `npm view @multiagentcoordinationprotocol/proto`
  against the public registry returns `404`. The package is real
  (`../multiagentcoordinationprotocol/packages/proto-npm/package.json`, `0.1.3`) but is published
  to **GitHub Packages** (`npm.pkg.github.com`) — confirmed via
  `../macp-sdk-typescript/.npmrc` (`@multiagentcoordinationprotocol:registry=...`) and its
  lockfile, which already consumes it that way. GitHub Packages requires an authenticated
  `npm install` even for public packages, so adding it as a real `devDependency` here would have
  put a `GITHUB_TOKEN`/PAT requirement on every contributor's plain `npm ci` — lint, typecheck,
  test, build, not just this one opt-in script — for a dependency only the e2e script needs.
- **Chosen fix:** `scripts/e2e-runtime.sh`'s `expect_accept`/`expect_reject` now resolve
  `macp.v1.MACPRuntimeService` client-side via `grpcurl -import-path`/`-proto`, never asking the
  server for reflection at all. The three needed `.proto` files (`envelope.proto`, `core.proto`,
  `policy.proto` — confirmed via `../macp-runtime/build.rs:21-23` as the exact set macp-runtime's
  own build compiles for this service; confirmed via `grep -n "^import"` that none import anything
  beyond each other, and none import any `google/protobuf/*` well-known type) are sourced by a new
  `resolve_proto_dir()` helper, priority order: explicit `MACP_PROTO_DIR` override, a sibling
  `../multiagentcoordinationprotocol` checkout (this workspace's existing convention), or a fetch
  from that repo's public GitHub raw content pinned to `MACP_PROTO_VERSION` (default
  `proto-v0.1.10`). That tag was verified three ways to match what's actually running: (a)
  `../macp-runtime/Cargo.toml:65` pins `macp-proto = "0.1.10"`, unchanged between the
  `macp-runtime-v0.8.0` tag (what `:latest` was reported as) and current `main`; (b)
  `git diff proto-v0.1.10 HEAD -- schemas/proto/macp/v1/{core,envelope,policy}.proto` in the
  schema repo is empty; (c) the schema repo is confirmed public
  (`gh repo view ... --json isPrivate` → `false`), so the raw-content fetch needs zero auth.
- **Rejected alternatives:** vendoring a static copy of the three files (guarantees silent drift
  the moment `macp-runtime` bumps its pin, with nothing to notice); keeping reflection as a
  preferred path with `-proto` as fallback (needless branching — `-proto` resolution doesn't care
  whether the target has reflection, so there's no case where reflection-first is better);
  `buf export buf.build/multiagentcoordinationprotocol/macp` (works fully unauthenticated —
  verified live — but the schema repo's CI push has no tag-synced BSR label, so it tracks `main`'s
  latest state rather than a stable, reproducible pin the way `MACP_PROTO_VERSION` does; would also
  add `buf` as a new required tool for no offsetting benefit here).
- **Verification gate:** a fresh Opus subagent reviewed the plan before implementation (not the
  diff — `/plan`'s own re-verification step) and returned `REVISE` with 6 items, none requiring a
  redesign: two off-by-one file:line citations; an overclaimed "never a false pass" on sibling-
  checkout drift (proto3 additive changes are forward-compatible and wouldn't be caught — narrowed
  to "no *breaking* wire-shape drift goes undetected"); a proposed test methodology (temporarily
  renaming the sibling repo's proto directory) that conflicted with the plan's own read-only-
  sibling invariant, replaced with a `MACP_PROTO_SKIP_SIBLING` test-only env knob; two missing
  acceptance criteria (temp-dir cleanup after a network-fetch run, and the `MACP_PROTO_DIR`-
  incomplete failure path); and the `buf export` alternative above, which the draft hadn't
  considered. The same agent independently reproduced the core mechanism live — pulled the real
  `ghcr.io/.../macp-runtime:latest` image and ran `grpcurl -import-path/-proto` against it,
  confirming RS256 accept / garbage-bearer `Unauthenticated` / ES256 accept — before flagging any
  gaps. All six applied; plan re-reviewed as `SOUND`, no second round needed (narrow, non-rippling
  corrections). Implementation then verified live, for real, against the actual default image:
  default run (sibling-checkout path) → `ALL CHECKS PASSED`; `MACP_PROTO_SKIP_SIBLING=1` (forces
  network fetch) → `ALL CHECKS PASSED`, temp dir confirmed removed after exit;
  `MACP_PROTO_DIR` pointed at a complete manually-fetched dir → `ALL CHECKS PASSED`; pointed at an
  incomplete one → immediate named failure before any Docker/auth-service work started. Full
  regression: `npm run lint`, `npm run typecheck`, `npm test` (54/54) all green, unmodified.
- **Decided by:** Opus — reversible, single-repo, opt-in-dev-tooling change; no production code
  touched; no cross-repo write (the schema/sibling repos were only ever read).
- **Status:** `ASSUMPTIONS.md`'s entry updated to `RESOLVED (2026-09-25)`. No further gap tracked —
  the script now passes end to end against the real default published image, which was the whole
  point of the original 2026-09-23 assumption.
- **Addendum — verification-gate finding closed same day:** the phase's fresh-Opus verifier (PASS,
  not GAPS) flagged one unblocking-but-real finding not addressed by the plan's Security notes:
  `MACP_PROTO_VERSION` was interpolated unsanitized into the `raw.githubusercontent.com` fetch URL,
  and `curl`'s own path-normalization means a crafted value (e.g. containing `../../`) could
  redirect the "trusted" schema fetch to an arbitrary public GitHub org/repo/ref. Low severity for
  this script's threat model (opt-in, hand-run; whoever sets env vars already controls the
  invocation), but cheap to close correctly rather than leave as a known gap: added a `case` guard
  in `resolve_proto_dir()` (`scripts/e2e-runtime.sh`) rejecting any value containing `..`, a leading
  `/`, or a character outside `[A-Za-z0-9._/-]`. Verified live: the legitimate default still passes
  fully via the network-fetch tier; a traversal payload is now rejected immediately with a named
  error. `shellcheck` clean throughout.
