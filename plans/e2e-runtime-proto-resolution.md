# Stop depending on gRPC reflection in scripts/e2e-runtime.sh

## Context

`scripts/e2e-runtime.sh` verifies the auth-service's minted JWTs against a real
`macp-runtime` container. Its `expect_accept`/`expect_reject` helpers
(`scripts/e2e-runtime.sh:168-194`) call `grpcurl` without `-proto`/`-protoset`, so
`grpcurl` must ask the server itself, via gRPC server reflection, what
`macp.v1.MACPRuntimeService/ListSessions` looks like. `macp-runtime` only started
shipping reflection at all very recently (PR #188, `1d0b2a7`), and only behind a
**non-default** `reflection` Cargo feature — confirmed by reading
`../macp-runtime/Cargo.toml:72,79` (`default = []`,
`reflection = ["dep:tonic-reflection"]`) and `../macp-runtime/Dockerfile:19` (bare
`cargo build --release`, no `--features`). So the script's default
`MACP_RUNTIME_IMAGE` (the real published `ghcr.io/.../macp-runtime:latest`) still
can't run it end to end; the only way to get a full pass today is to build a
throwaway local image with `--features reflection` (`ASSUMPTIONS.md`,
`DECISIONS.md`, both 2026-09-23 entries).

**One resource claim turned out to be stale and is corrected here:**
`DECISIONS.md`'s 2026-09-23 entry says the proto definitions are "already
published as npm `@multiagentcoordinationprotocol/proto`" as if that meant the
public npm registry — `npm view @multiagentcoordinationprotocol/proto` 404s there.
The package is real (`../multiagentcoordinationprotocol/packages/proto-npm/package.json`,
version `0.1.3`) but is published to **GitHub Packages**
(`npm.pkg.github.com`), confirmed by `../macp-sdk-typescript/.npmrc`
(`@multiagentcoordinationprotocol:registry=https://npm.pkg.github.com`) and its
lockfile, which already depends on it that way. GitHub Packages requires an
authenticated `npm install` even for public packages — installing it as a real
`package.json` devDependency here would mean every contributor's plain `npm ci`
(lint/typecheck/test/build, not just this opt-in script) needs a
`GITHUB_TOKEN`/PAT wired into `.npmrc`, for a dependency only the opt-in e2e
script needs. That's a worse trade than the one `DECISIONS.md` priced.

The actual best source is simpler and already free: the schema's home repo,
`multiagentcoordinationprotocol/multiagentcoordinationprotocol`, is a **public**
GitHub repo (confirmed: `gh repo view` → `"isPrivate":false`). Its raw `.proto`
files are fetchable over plain HTTPS with zero auth
(`https://raw.githubusercontent.com/multiagentcoordinationprotocol/multiagentcoordinationprotocol/<tag>/schemas/proto/macp/v1/*.proto`
— fetched live during this planning pass to confirm). Tag `proto-v0.1.10` matches
exactly what `macp-runtime` already depends on — confirmed three ways: (a)
`../macp-runtime/Cargo.toml:65` pins `macp-proto = "0.1.10"`, unchanged between the
currently-published `macp-runtime-v0.8.0` tag and current `main`; (b)
`git diff proto-v0.1.10 HEAD -- schemas/proto/macp/v1/{core,envelope,policy}.proto`
in the schema repo is empty (byte-identical); (c) `macp-runtime`'s own
`build.rs` (`../macp-runtime/build.rs`) compiles exactly these three files —
`envelope.proto`, `core.proto`, `policy.proto` — for the service stubs, and
neither `envelope.proto` nor `policy.proto` imports anything else
(`grep -n "^import" .../envelope.proto .../policy.proto` → no hits); `core.proto`
imports only those two (`core.proto:5-6`). No `google/protobuf/*` well-known-type
imports anywhere in the three files, so no further dependency chasing is needed —
`grpcurl -import-path <dir> -proto macp/v1/core.proto` is self-sufficient once
those three files are on disk in that layout.

That means the fix doesn't need reflection at all, in any form — client-side
`-proto` resolution works identically whether the target image was built with
`--features reflection` or not. The local `--features reflection` Docker detour
this repo used to verify PR #188 becomes unnecessary for this script's own
purposes; reflection stays useful to `macp-runtime` for other things, but this
script no longer needs to care whether the target image has it.

## Phase 1 — Resolve the service by schema, not by asking the server

**Status:** DONE (2026-09-25). Implemented as planned, one addition beyond the
original scope: the fresh-Opus verification gate (see `PROGRESS.md`) found
that `MACP_PROTO_VERSION` was spliced unsanitized into the fetch URL — `curl`'s
own path-segment normalization meant a crafted value (e.g. containing `../../`)
could retarget the fetch to an arbitrary GitHub org/repo/ref. Low severity
given the threat model (opt-in, hand-run dev script), but cheap and correct to
close immediately rather than defer: added a `case` guard in
`resolve_proto_dir()` rejecting any `MACP_PROTO_VERSION` containing `..`, a
leading `/`, or any character outside `[A-Za-z0-9._/-]`, before it's used in
the URL. Verified live both ways: the legitimate default (`proto-v0.1.10`,
network-fetch tier) still passes fully; a `../../anthropics/anthropic-sdk-python/main`
value is now rejected immediately with a named error instead of silently
fetching foreign content.

**Delivers:** `scripts/e2e-runtime.sh` passes end to end
(`RS256 accept` / `garbage-bearer reject` / `ES256 accept`) against the **default**
`MACP_RUNTIME_IMAGE` (the real published `ghcr.io/multiagentcoordinationprotocol/macp-runtime:latest`),
with no reflection feature, no custom local image build, and no new runtime
`package.json` dependency or registry auth requirement.

**Depends on:** nothing (this repo's tip is clean and merged; no other work in flight).

**Files:**
- `scripts/e2e-runtime.sh` — modify
- `README.md` — modify (remove the now-false "Known issue" paragraph)
- `docs/integration.md` — modify (Pattern 3's `grpcurl` example has the identical
  reflection dependency — same class of bug the 2026-09-23 verifier caught for
  `Initialize`; fix it alongside since it's the same root cause resurfacing)
- `CHANGELOG.md` — modify (`[Unreleased] > Changed`)
- `ASSUMPTIONS.md` — modify (close out the tracked entry)
- `DECISIONS.md` — modify (append the resolution, and correct the npm-registry
  claim from the prior entry rather than leaving it silently wrong)

**Approach:**

1. **Add a `resolve_proto_dir()` helper** near the top of `scripts/e2e-runtime.sh`,
   alongside the existing `log`/`fail`/`need` helpers. Resolution order, highest
   priority first, logged so a failure is diagnosable rather than mysterious:
   - **Explicit override** — `MACP_PROTO_DIR` env var, if set: used as-is (must
     already contain `macp/v1/{envelope,core,policy}.proto`; fail with a clear
     message if it doesn't). Lets CI or an air-gapped run point at a pre-fetched
     copy.
   - **Sibling checkout** — if `../multiagentcoordinationprotocol/schemas/proto/macp/v1/{envelope,core,policy}.proto`
     all exist (this workspace's existing convention: siblings checked out
     side by side — same three-file check as the override tier above, for
     equally clear failure messages if one is missing/corrupted), use
     `../multiagentcoordinationprotocol/schemas/proto` directly. Fast, offline,
     and always exactly what the developer currently has checked out — matches
     how this repo already treats sibling repos elsewhere (e.g. the v0.8.1
     re-verification plan read `../macp-runtime` directly). Log which path was
     used. A test-only `MACP_PROTO_SKIP_SIBLING=1` knob forces skipping this
     tier even when the sibling is present, so the network-fetch tier below can
     be exercised on demand without touching the sibling checkout at all (see
     Tests).
   - **Network fetch** — otherwise, `mktemp -d`, recreate the `macp/v1/` layout,
     and `curl -fsS` each of the three files from
     `https://raw.githubusercontent.com/multiagentcoordinationprotocol/multiagentcoordinationprotocol/${MACP_PROTO_VERSION:-proto-v0.1.10}/schemas/proto/macp/v1/<file>`.
     `MACP_PROTO_VERSION` is overridable so this can be bumped independently of a
     script edit when `macp-runtime`'s own `macp-proto` pin moves. Register the
     temp dir for cleanup in the existing `cleanup()` trap (`scripts/e2e-runtime.sh:82-88`)
     so it's removed on exit like the other ephemeral resources.
   - This is a deliberate, honest tradeoff, not a gap: the sibling-checkout path
     trusts whatever schema the developer currently has on disk, which could in
     principle be ahead of what the target image actually implements. A
     *breaking* change to `ListSessions`'s wire shape fails loudly (a real
     `grpcurl` protocol error naming the mismatched field/method) rather than
     silently. A purely *additive* one (a new optional field, a new RPC) is
     proto3-forward-compatible and would round-trip fine against an older
     running server either way — an accepted, bounded gap for what this script
     actually probes (auth accept/reject on `ListSessions`), not a claim that
     drift can never go unnoticed. Same trust model this whole repo already
     extends to sibling checkouts elsewhere in this codebase.
2. **Retarget `expect_accept`/`expect_reject`** (`scripts/e2e-runtime.sh:168-194`) to
   pass `-import-path "${PROTO_DIR}" -proto macp/v1/core.proto` on every `grpcurl`
   invocation, in addition to the existing flags. Resolve `PROTO_DIR` once, before
   the RS256/ES256 loop, via `resolve_proto_dir`. `ListSessions` itself (the
   auth-probe target fixed in the prior session's PR #32) is unchanged — this
   phase only changes *how the service is located*, not which RPC is called or
   what body is sent.
3. **Rewrite the script's header comment.** Delete the "REFLECTION" section
   (lines 26-36) entirely — it describes a limitation that no longer exists.
   Replace with a short note that the service is resolved from the versioned
   `.proto` schema (naming the three resolution sources and the default pinned
   version), so a future reader doesn't go looking for a reflection dependency
   that's been designed out.
4. **`docs/integration.md`'s "Pattern 3: ad-hoc tooling" example** currently reads
   (post the 2026-09-23 fix) `grpcurl -H "authorization: Bearer ${TOKEN}" -d '{}' macp-runtime:50051 macp.v1.MACPRuntimeService/ListSessions`
   — correct on *which* RPC to call, but it silently assumes the target runtime
   serves reflection, which a real deployed instance (the published image)
   won't. Add the `-proto`/`-import-path` flags to this example too (pointing at
   wherever the reader's own `macp-proto`/schema checkout lives, since this is
   user-facing guidance, not this repo's own resolution helper), with a one-line
   note on why reflection isn't assumed. This is the same defect class the prior
   verification gate caught once already (the `Initialize` anti-pattern); fixing
   the sibling instance now instead of leaving it for the next person to
   rediscover.

**Rejected alternatives:**
- **Add `@multiagentcoordinationprotocol/proto` as a real `devDependency`** (what
  `DECISIONS.md`'s prior entry assumed): rejected — see Context above. It would
  put a GitHub Packages auth requirement on every contributor's plain `npm ci`,
  for a dependency only one opt-in script needs. If this org's Node repos ever
  need the proto package for real production code (not just an e2e probe), that
  tradeoff is worth revisiting *for that use case* — it isn't one here.
- **Vendor a static copy of the three `.proto` files into this repo**: rejected —
  guarantees silent drift the moment `macp-runtime` bumps its `macp-proto` pin;
  nothing here would ever notice. The network-fetch-by-tag path gets the same
  reliability without the staleness risk, at the cost of one `MACP_PROTO_VERSION`
  bump when it matters (documented, not automated — see Long-term posture).
- **Keep reflection as the primary path and add `-proto` only as a fallback for
  images without it**: rejected — needless branching. `-proto` resolution works
  identically regardless of whether the target image has reflection; there is no
  scenario where preferring reflection is better, and maintaining both paths
  would double the surface this script's tests need to cover for zero benefit.
- **`buf export buf.build/multiagentcoordinationprotocol/macp`**: the schema repo
  already pushes to this BSR module on every `main` push (`../multiagentcoordinationprotocol/buf.yaml`,
  `.github/workflows/ci.yml:118-123`), and `buf export` against it works fully
  unauthenticated — confirmed live, with an empty `$HOME`/no token, during this
  plan's review. Rejected anyway, for one concrete reason: that CI push carries
  no `--label`/tag-sync step tying a BSR reference to this repo's `proto-v*` git
  tags, so an unqualified `buf export` tracks whatever last landed on `main`,
  not a stable pin — reproducing `MACP_PROTO_VERSION=proto-v0.1.10`'s exact,
  reproducible-by-tag behavior would need resolving a git tag to a BSR commit ID
  by hand, which isn't wired up anywhere today. It would also add `buf` as a new
  required tool (`scripts/e2e-runtime.sh:75-79`'s `need` checks) for a benefit
  the raw-fetch-by-tag approach already gets for free. Worth revisiting if the
  schema repo ever adds tag-synced BSR labels.

**Edge cases & failure modes:**
- `MACP_PROTO_DIR` set but incomplete/wrong → `resolve_proto_dir` fails fast with
  a named missing file, not a confusing downstream `grpcurl` parse error.
- No sibling checkout, no network (offline dev machine, air-gapped CI) → the
  existing `curl -fsS` failure surfaces directly (non-2xx or DNS failure), same
  failure shape the script already produces for other `curl` calls (`mint()`,
  the auth-service healthz poll) — no new error-handling pattern introduced.
- Sibling checkout present but on a feature branch with in-progress,
  not-yet-released schema changes → addressed above (Approach, point 1): a
  breaking wire-shape change fails loud via a real grpcurl error; a purely
  additive one (new optional field, new RPC) is proto3-compatible and isn't
  caught by this script either way — an accepted, bounded gap, not a claim that
  every form of drift is detected.
- `raw.githubusercontent.com` is a CDN for repo content, not the GitHub REST API
  — no API rate-limit exposure from this fetch, even run repeatedly.
- Concurrent runs (two developers running the script at once) → each gets its
  own `mktemp -d`; no shared mutable state, same isolation model the script
  already uses for `NET_NAME`/`AUTH_NAME`/`RUNTIME_NAME` (all suffixed with `$$`).

**Acceptance criteria:**
1. `bash -n scripts/e2e-runtime.sh` passes (syntax).
2. Running `scripts/e2e-runtime.sh` with **no env overrides at all** (default
   `MACP_RUNTIME_IMAGE=ghcr.io/multiagentcoordinationprotocol/macp-runtime:latest`)
   ends with `ALL CHECKS PASSED` — this is the actual gap being closed, not just
   a code change; it must be run for real, not simulated.
3. Running it again with `MACP_PROTO_DIR` pointed at a manually-fetched directory
   also passes, proving the override path works.
4. Running it with the sibling checkout present (the normal case in this
   workspace) logs that it used the sibling path, not a network fetch.
5. `README.md` no longer contains a "Known issue" paragraph describing a
   reflection dependency; `docs/integration.md`'s Pattern 3 example includes
   `-proto`/`-import-path`.
6. `ASSUMPTIONS.md`'s entry status reflects full resolution (not
   "LOCAL-FIX-VERIFIED" with a remaining default-image gap — the gap is closed).
7. `npm run lint && npm run typecheck && npm test` all still pass unmodified
   (this phase touches no `src/` code).
8. After a `MACP_PROTO_SKIP_SIBLING=1` run (forcing the network-fetch tier), the
   `mktemp -d` temp directory the script created no longer exists once the
   script exits — proving the `cleanup()` trap actually covers it, not just
   that the fetch itself succeeded.
9. Running with `MACP_PROTO_DIR` pointed at a directory missing one of the
   three required `.proto` files fails immediately, before any Docker/grpcurl
   work starts, with a message naming the specific missing file.

**Tests:**
- The script has no unit-test harness of its own (it's a standalone opt-in bash
  script, deliberately not wired into `npm test` — unchanged by this phase).
  Its "test" is running it for real, per acceptance criteria 2-4 and 8-9 above,
  against: (a) the default published image with the normal sibling-checkout
  resolution; (b) the default published image with `MACP_PROTO_SKIP_SIBLING=1`
  set, forcing and proving the network-fetch fallback actually works, and that
  its temp dir is cleaned up on exit — without touching the sibling checkout at
  all; (c) `MACP_PROTO_DIR` pointed at a manually-fetched, complete directory
  (override tier); (d) `MACP_PROTO_DIR` pointed at a directory missing one file,
  confirming the fast, named failure.
  The sibling checkout under `../multiagentcoordinationprotocol` is never
  modified, even temporarily — read-only in that repo, exactly as this whole
  session has already treated it.
- `npm run lint`, `npm run typecheck`, `npm test` — regression check that no
  `src/` behavior changed (this phase is scripts/docs only).

**Docs:** `README.md`, `docs/integration.md`, `CHANGELOG.md`, `ASSUMPTIONS.md`,
`DECISIONS.md` — all listed under Files above; all in this repo, no cross-repo
doc edits triggered by this phase.

## Long-term posture

- **Manual version sync is the one accepted piece of debt.** `MACP_PROTO_VERSION`'s
  default (`proto-v0.1.10`) must be bumped by hand if `macp-runtime` ever moves
  its `macp-proto` Cargo pin to a version with an incompatible wire shape for
  `Initialize`/`ListSessions`/`Send`/etc. Nothing here detects that drift
  automatically. This is the same class of manual-sync obligation this repo
  already carries for its runtime-version re-verification passes
  (`plans/absorb-runtime-v0.5.0.md` → `plans/absorb-runtime-v0.8.1.md`), just at
  the granularity of one script instead of the whole service — not a new kind of
  risk, and not proportionate to automate for an opt-in dev script whose failure
  mode is "a clear grpcurl error," never a silent false pass.
- **Not a one-way door.** Everything here is local to one opt-in script plus its
  own docs; nothing changes a public contract, a schema, or anything another
  service depends on. Fully reversible in a single commit if this approach ever
  needs revisiting.

## Enterprise concerns

- **Reliability:** the network-fetch fallback depends on `raw.githubusercontent.com`
  availability. Given this script is opt-in, run by hand, and not on any
  deploy/release critical path, an occasional transient fetch failure is an
  acceptable, clearly-diagnosed failure mode (same tier as the script's existing
  dependence on `ghcr.io` being reachable to pull the runtime image itself).
- **Security:** fetching public, unauthenticated `.proto` text files over HTTPS
  from the project's own public schema repo introduces no new secret-handling or
  credential surface — a strict reduction in surface versus the rejected
  GitHub-Packages-devDependency alternative, which would have required a token.
- **Observability:** `resolve_proto_dir` logs which of the three sources it used
  (override / sibling / network) via the script's existing `log()` helper, so a
  failure or an unexpected pass is diagnosable from the script's own output
  without needing to instrument anything further.

## Open questions

None outstanding. The one real fork — devDependency-on-GitHub-Packages vs.
fetch-by-tag-from-the-public-schema-repo — is a reversible, same-repo,
opt-in-dev-tooling choice (Autonomy ladder: "not critical," decided and recorded
above, not escalated). `MACP_PROTO_VERSION`'s default value is decided (matches
`macp-runtime`'s current pin, verified byte-identical against the tag) rather
than left open.

## Repo map

- `scripts/e2e-runtime.sh` — the file this whole plan modifies; existing
  structure: `log`/`fail`/`need` helpers (:72-79), `cleanup()` trap (:82-88),
  `start_auth`/`stop_auth`/`start_runtime` (:95-148), `mint()` (:150-155),
  `expect_accept`/`expect_reject` (:168-194), main sequence (:196-218).
- `../macp-runtime/Cargo.toml:65,72,79` — `macp-proto = "0.1.10"` pin;
  `reflection` feature definition, `default = []`.
- `../macp-runtime/build.rs` — confirms the exact 3-file compile set
  (`envelope.proto`, `core.proto`, `policy.proto`) this plan's `-import-path`
  approach mirrors.
- `../multiagentcoordinationprotocol/schemas/proto/macp/v1/{envelope,core,policy}.proto` —
  the schema source; `core.proto:457-487` is `service MACPRuntimeService`;
  `core.proto:5-6` are its only imports (the other two files, which import
  nothing themselves).
- `../multiagentcoordinationprotocol/packages/proto-npm/package.json` — the real
  but GitHub-Packages-only npm package this plan deliberately does not add as a
  devDependency.
- `../macp-sdk-typescript/.npmrc`, `package.json:58` — confirms how a sibling
  Node repo in this org actually consumes that package today (scoped registry +
  CI token), i.e. the pattern this plan avoids taking on for a single opt-in
  script.
- `README.md:153-168` — "End-to-end against a live runtime" section, including
  the now-stale "Known issue" paragraph this phase removes.
- `docs/integration.md` — "Pattern 3: ad-hoc tooling" example, same defect class
  as the `Initialize`-vs-`ListSessions` bug the prior session's verifier caught.
- `ASSUMPTIONS.md`, `DECISIONS.md` — the tracked entries this phase closes out.

## Plan review

**Round 1 — REVISE.** Fresh Opus agent, independent of the drafting agent. It
went further than a citation check: it actually pulled the real published
`ghcr.io/multiagentcoordinationprotocol/macp-runtime:latest` image and ran the
proposed `grpcurl -import-path/-proto` mechanism against it live — RS256
accept, garbage-bearer `Unauthenticated`, ES256 accept, all confirmed for
real — and confirmed `grpcurl` auto-resolves `envelope.proto`/`policy.proto`
transitively from `-import-path` (only `core.proto` need be passed to `-proto`),
answering empirically what the original draft had only inferred. It also
independently re-verified every citation and factual claim in Context (public
repo, raw-fetch success, byte-identical schema at the pinned tag, npm 404,
unchanged Cargo pin) — all confirmed. Six items came back, all applied to this
file, none requiring a redesign:
1. Two off-by-one line citations (`scripts/e2e-runtime.sh:196-219` →
   `:196-218`; `core.proto:457-486` → `:457-487`) — fixed.
2. "Never a false pass" was an overclaim (proto3 additive changes are
   forward-compatible and wouldn't be caught) — softened in Approach and Edge
   cases to scope the claim to breaking wire-shape changes specifically.
3. The proposed fallback test (temporarily renaming the sibling checkout's
   `schemas/proto` dir) conflicted with the plan's own read-only-sibling
   invariant and had no safety net — replaced with a `MACP_PROTO_SKIP_SIBLING`
   test-only knob; Tests section rewritten accordingly.
4. Missing acceptance criteria for temp-dir cleanup and the
   `MACP_PROTO_DIR`-incomplete failure path — added as criteria 8-9 and folded
   into Tests.
5. The sibling-checkout tier only checked `core.proto`'s existence while the
   override tier checked all three files — made consistent (both check all
   three now).
6. `buf export` against the schema repo's BSR module was a real,
   unauthenticated-working alternative the draft never considered — added to
   Rejected alternatives with the concrete reason it wasn't chosen (no
   tag-synced BSR labels today, so it can't reproduce `MACP_PROTO_VERSION`'s
   pinning story without extra unwired tooling).

**Round 2 — not needed.** All six items were narrow corrections (citations,
claim-scoping, one test-methodology swap, two added criteria, one added
alternative) with no ripple into other sections; nothing here surfaced a new
open question or contradicts another part of the plan. Verdict after
revision: **SOUND**.
