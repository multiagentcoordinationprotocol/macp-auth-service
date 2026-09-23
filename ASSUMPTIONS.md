# Assumptions

Logged per `/implement`'s standing constraints. Reconciled via `/reconcile`.

## e2e-runtime.sh's grpcurl calls depend on reflection the current runtime image doesn't expose
- **Plan:** plans/absorb-runtime-v0.8.1.md
- **Assumed:** `scripts/e2e-runtime.sh` (written and passing during the prior `absorb-runtime-v0.5.0`
  pass) still works unmodified against a current published runtime image.
- **Chose:** Ran it live against `ghcr.io/multiagentcoordinationprotocol/macp-runtime:latest`
  (reports `v0.8.0` at boot — see note below) with Docker + grpcurl available locally. Found the
  script's readiness check (`grpcurl -plaintext ... list`) and its functional calls in
  `expect_accept`/`expect_reject` (bare `grpcurl ... macp.v1.MACPRuntimeService/Initialize`, no
  `-proto`/`-protoset`) both fail with `"server does not support the reflection API"` — this runtime
  build does not serve gRPC server reflection, which grpcurl needs to resolve a service by name
  without a local proto file. Fixed the readiness check to a plain TCP-connect
  (`exec 3<>/dev/tcp/127.0.0.1/$PORT`), which is correct regardless of reflection support and got the
  script past its first failure point. Left `expect_accept`/`expect_reject` unfixed: making them work
  without reflection means wiring `grpcurl -proto`/`-protoset` to the actual `macp-proto` service
  definitions — locating the right `.proto`, keeping it version-synced with `macp-proto`, verifying
  method signatures — which is real, separate engineering work, not something a docs-refresh
  re-verification plan should absorb as an unplanned addition.
- **Alternatives:** (a) leave the whole script untouched, only note the issue — rejected, the
  TCP-connect fix is small, strictly correct, and worth keeping on its own merits; (b) fully wire
  proto-based grpcurl invocation now — rejected as materially larger than this plan's scope and not
  something to do hastily; (c) revert the readiness-check fix too, to minimize this phase's diff —
  rejected, since it's a genuine improvement that doesn't regress anything.
- **Blast radius if wrong:** `scripts/e2e-runtime.sh` still cannot complete end-to-end (it now
  progresses further — past the readiness check — before failing clearly at `expect_accept` with the
  same reflection error, rather than timing out opaquely at the old readiness loop). It is opt-in,
  not wired into CI or `npm test` (confirmed in the prior `absorb-runtime-v0.5.0` plan's inventory),
  so nothing in this repo's release path depends on it. The offline `src/contract.spec.ts` wire-shape
  pin is unaffected by any of this and remains green. Low blast radius either way: worst case, a
  future contributor running this script by hand hits a clear grpcurl error instead of a silent
  false pass, and knows exactly what to fix (this entry names it precisely).
- **Aside (not itself an assumption, just a fact worth recording alongside):** the published
  `:latest` image tag reports `macp-runtime v0.8.0` at boot, while `../macp-runtime`'s current source
  is at `v0.8.1` (commit `2ce6480`). The commits between the two release tags
  (`4836ea7`, `48bfc7c`, `b6e8f58`, `7815a97`, `a24ca65`) touch no file under `crates/macp-auth`, so
  this lag is immaterial to this plan's wire-contract conclusions — noted so a future reader doesn't
  mistake it for a fresh discrepancy.
- **Status:** RESOLVED-UPSTREAM, LOCAL-FIX-VERIFIED (2026-09-23). Root cause confirmed: reflection
  was never implemented in `macp-runtime` (zero hits for `reflection` in its source or git history,
  at the time of the original investigation, pre-PR-#188)
  — not a hardening removal, so no security rationale blocked adding it. A nice-to-have issue was
  filed against `macp-runtime` (2026-09-23, after the session owner's go-ahead):
  https://github.com/multiagentcoordinationprotocol/macp-runtime/issues/187 — **fixed same day**
  via `macp-runtime` PR #188 (commit `1d0b2a7`): reflection is now available behind a non-default
  `reflection` Cargo feature, off by default and **not built into the published `ghcr.io` image**.
  Empirically verified 2026-09-23: built a local runtime image with `--features reflection`
  (scratchpad-only Dockerfile, macp-runtime repo untouched) and ran `scripts/e2e-runtime.sh`
  against it — reflection resolved cleanly, and the script now passes fully end to end.
  That run also surfaced a second, independent bug in the script itself: `expect_accept`/
  `expect_reject` targeted `Initialize`, which never calls `authenticate_metadata` in any version
  of `macp-runtime` (confirmed via full git history of `src/server.rs`) — so it would have accepted
  *any* bearer, valid or garbage, once past the reflection error, and could never actually have
  proven acceptance/rejection. Fixed by retargeting both to `ListSessions`, which checks auth first
  (`src/server.rs:1271-1277`). Remaining gap: **the script still fails against the default
  `MACP_RUNTIME_IMAGE`** (published `:latest`), since that image doesn't build in the reflection
  feature — a full default run still needs either a locally-built `--features reflection` runtime,
  or the still-undone `-proto`/`-protoset` wiring against the published `macp-proto` schema
  (`DECISIONS.md`'s "well-scoped, deferred follow-up," not done here — bigger than a script fix,
  a real feature addition with its own devDependency). The offline `src/contract.spec.ts`
  wire-shape pin remains the load-bearing check for a default/CI-less run.
