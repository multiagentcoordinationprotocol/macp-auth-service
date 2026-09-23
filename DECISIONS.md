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
     on it. **Not filed by this pass** — posting to another repo's public tracker needs the session
     owner's explicit go-ahead, batched with the plan's separate Open Question 1
     (the `docs/deployment.md:292` doc-bug issue) and surfaced together at the end of this session.
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
