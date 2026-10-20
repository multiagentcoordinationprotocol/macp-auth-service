# Plan: align auth-service with macp-runtime 0.9.0 (0.8.9 slice #228, 0.9.0 #229, spec pin #232)

Status: DONE (3 of 3 phases complete)
Owner: auth-service maintainers
Scope: this repo only (`auth-service`). No sibling-repo changes proposed.
Ground truth (siblings under `/Users/Shared/multiagentcoordinationprotocol/`): `../macp-runtime` @
`b350646` (`[workspace.package].version = "0.9.0"`, `Cargo.toml:24`; `macp-proto = "0.1.11"`,
`Cargo.toml:65`), auth-service judged at `origin/main` `28c783e`.

---

## Context

macp-runtime shipped 0.9.0 on 2026-10-17 (release `macp-runtime-v0.9.0`; image
`ghcr.io/multiagentcoordinationprotocol/macp-runtime:0.9.0` / `:0.9` is published):

- [#228](https://github.com/multiagentcoordinationprotocol/macp-runtime/pull/228) — 0.8.9 slice:
  policy value-domain admission, `schema_version` {1,2,3}, RFC-MACP-0013 verify API.
- [#229](https://github.com/multiagentcoordinationprotocol/macp-runtime/pull/229) — 0.9.0:
  `semantics_rev` 4, S13 status mapping, closed policy rule objects, `session_id` <= 128 bytes,
  **macp-proto 0.1.11**, and the new `WatchSignalsResponse.sender_authenticated` flag.
- [#232](https://github.com/multiagentcoordinationprotocol/macp-runtime/pull/232) — spec pin
  `60262b8`; the four control-plane codes become permanent.

auth-service only mints JWTs the runtime verifies, so almost all of this is out of its reach. What
the runtime-side diff `macp-runtime-v0.8.8..macp-runtime-v0.9.0 -- crates/macp-auth` shows:

- **No verifier drift.** `crates/macp-auth/src/auth/` (JWT resolver, `MACPClaims`/`MACPScopes`,
  alg allowlist, JWKS cache and stale grace) is untouched. The offline wire-shape pin in
  `src/contract.spec.ts` stays correct. `src/main.rs` has no auth or insecure-gate changes.
- **One additive auth-facing behaviour.** `SecurityLayer::authenticates_senders()`
  (`crates/macp-auth/src/security.rs:509-515`) is true when JWT is configured. `WatchSignals` sets
  `sender_authenticated` from it (`src/server.rs:1413-1421`), so a Signal sent with a token minted
  here is delivered with `sender_authenticated = true` (runtime `docs/API.md:367`, pinned by
  `integration_tests/tests/tier1_jwt.rs:192-253`). This is the first runtime behaviour that depends
  on this service's tokens being real verified credentials rather than dev-mode self-assertion.
  Neither the docs nor the e2e script cover it.

The e2e script's protocol pin and source citations have drifted:

- `scripts/e2e-runtime.sh:61-62` says the `proto-v0.1.10` default "matches macp-runtime's current
  macp-proto pin, Cargo.toml:65". It no longer does: the runtime pins `0.1.11`, and tag
  `proto-v0.1.11` exists in the spec repo. `scripts/e2e-runtime.sh:136` holds the default value.
  The 0.1.10→0.1.11 diff touches `core.proto` (+7) and `policy.proto` (+6). `sender_authenticated`
  is one of those fields, so Phase 2 cannot decode it under the old pin.
- `scripts/e2e-runtime.sh:229` cites `src/server.rs:1274-1278` for "ListSessions authenticates
  first". That code is now at `src/server.rs:1445-1450`. The behaviour is unchanged.
- The last re-verification (`CHANGELOG.md:53-56`, v0.8.8) was by source inspection only. The script
  was not re-run. No CHANGELOG entry covers 0.9.0.

Already done or not applicable, so excluded:
- The JWT claim shape, alg defaults and JWKS semantics need no change. They are unchanged, as above.
- Error codes: this service's tests only assert `UNAUTHENTICATED` (`scripts/e2e-runtime.sh`
  `expect_reject`), and its registry row is unchanged (`crates/macp-core/src/error.rs`, gRPC 16).
  The `POLICY_DENIED`, `Initialize` and four-new-code changes do not reach any path here.
- Policy admission, `semantics_rev`, `session_id` cap and `MACP_AUDIT_*`: this repo constructs no
  policies or sessions (`docs/integration.md:212` only passes through a control-plane `sessionId`).
- Open PRs/issues: none (`gh pr list` / `gh issue list` empty at time of writing).

## Phases

### Phase 1 — Re-pin the e2e script to proto-v0.1.11 and refresh stale citations

**Status: DONE**

**Goal:** the script's documented and default proto revision matches the runtime it targets, and its
source citations point at current code.

**Files to change**
- `scripts/e2e-runtime.sh:61-62` — change the default to `proto-v0.1.11` and update the comment
  ("matches macp-runtime's macp-proto pin, Cargo.toml:65 as of 0.9.0").
- `scripts/e2e-runtime.sh:136` — `${MACP_PROTO_VERSION:-proto-v0.1.11}`.
- `scripts/e2e-runtime.sh:229` — `src/server.rs:1274-1278` → `src/server.rs:1445-1450`, naming the
  runtime version the citation was read at, so the next drift is detectable.
- Leave `ASSUMPTIONS.md:57,64` and `DECISIONS.md:82,125-128` as they are. They are dated decision
  records for the 0.8.1 pass, not living docs.

**Acceptance criteria**
- `grep -n 'proto-v0.1.10' scripts/e2e-runtime.sh` returns nothing.
- With `MACP_PROTO_SKIP_SIBLING=1`, the network-fetch path downloads all three files at
  `proto-v0.1.11` and `grpcurl -import-path … -proto macp/v1/core.proto describe
  macp.v1.WatchSignalsResponse` lists `sender_authenticated`.
- `MACP_RUNTIME_IMAGE=ghcr.io/multiagentcoordinationprotocol/macp-runtime:0.9.0
  scripts/e2e-runtime.sh` ends `ALL CHECKS PASSED`, with RS256 accept, ES256 accept and garbage
  reject.

**Tests:** the live script run above, on both the sibling-checkout and the network-fetch resolution
paths. `npm test` stays green, though the script is not part of it.

### Phase 2 — Prove and document `sender_authenticated = true` for minted tokens

**Status: DONE**

**Goal:** the e2e probe verifies the one new runtime behaviour that depends on this service. A
Signal sent with a token minted here must reach a `WatchSignals` subscriber with
`sender_authenticated: true`. Integrators learn what the flag means for them.

**Files to change**
- `scripts/e2e-runtime.sh` — add `expect_signal_authenticated` to the RS256 block, after the
  `expect_accept` at line 278:
  1. Start `grpcurl … macp.v1.MACPRuntimeService/WatchSignals` in the background with the minted
     bearer, writing to a temp file, with a bounded `-max-time`.
  2. `Send` one ambient Signal envelope using the same bearer: `message_type: "Signal"`, empty
     `session_id` and `mode`, a fresh `message_id`, `macp_version` and a `SignalPayload`, as the
     runtime requires for the ambient plane.
  3. Assert the captured response contains `"senderAuthenticated": true` and the sent
     `messageId`. Fail with the captured output otherwise.
  Kill the watcher in `cleanup()`. Update the "What it proves" header (`:11-17`) with item 4.
- `docs/integration.md:70` (step 7) — add one sentence: on runtime >= 0.9.0, Signals sent with
  these tokens are delivered with `sender_authenticated = true`. Dev mode delivers `false`, so a
  subscriber can tell a verified sender from a self-asserted one. Link the runtime
  `docs/API.md` WatchSignals section rather than restating it, following this repo's
  "verifier semantics → macp-runtime docs" ownership rule (`PROGRESS.md:265`).

**Acceptance criteria**
- Against `:0.9.0`, the new check passes and logs `PASS: Signal delivered with sender_authenticated=true`.
- Run against a pre-0.9 image (e.g. `:0.8.8`), the check fails clearly, because the field is
  absent. The failure message names the runtime >= 0.9.0 floor, so it is not mistaken for an auth
  regression.
- The script leaves no orphaned `grpcurl` process: `pgrep -f WatchSignals` is empty after both
  success and failure runs.
- The docs sentence links to the runtime doc, and no runtime semantics are restated beyond the one
  sentence.

**Tests:** live script runs against `:0.9.0` (pass) and `:0.8.8` (expected, clearly worded fail).

### Phase 3 — Record the 0.9.0 re-verification

**Status: DONE**

**Goal:** the changelog states what was verified against 0.9.0 and how. Unlike the 0.8.8 entry, this
one rests on a live run.

**Files to change**
- `CHANGELOG.md` `[Unreleased]` → `### Changed` (after `:53-56`): add "Re-verified against
  macp-runtime v0.9.0. `crates/macp-auth` changed only additively (`authenticates_senders`), and
  JWT claim, alg and JWKS handling are unchanged. `scripts/e2e-runtime.sh` passes against the
  published `0.9.0` image for RS256 and ES256, the garbage-bearer reject, and the new
  `sender_authenticated` probe. The e2e proto pin moved to `proto-v0.1.11`."

**Acceptance criteria**
- The entry names the exact image tag the script was run against.
- It makes no claim that was not exercised in Phases 1-2.

**Tests:** none beyond Phases 1-2. `npm run lint` and `npm test` stay green.

## Compatibility / rollout

Nothing ships in the auth-service image: there is no `src/` change, and the minted token format is
unchanged. Tokens minted today work against 0.8.x and 0.9.0 runtimes alike. The e2e changes are
opt-in tooling. After Phase 2 the script requires runtime >= 0.9.0 by default. Older runtimes can
still be probed by pointing `MACP_PROTO_VERSION`/`MACP_RUNTIME_IMAGE` at them, with the Signal check
expected to fail as documented.

## Open questions

1. Should `MACP_RUNTIME_IMAGE` default to `:0.9` instead of `:latest`
   (`scripts/e2e-runtime.sh:53,68`)? The runtime documents that `:latest` tracks `main`, not the
   newest release (runtime `docs/deployment.md` "Published image tags"). So the default probe can
   test unreleased code while the proto pin names a released tag. The earlier 0.8.1 pass chose
   `:latest` deliberately (`DECISIONS.md`). Changing it is a reversal for the owner to make, not a
   gap this plan fills by assumption.
   **Resolved 2026-10-19:** owner chose `:0.9` (see `DECISIONS.md`).
