#!/usr/bin/env bash
#
# e2e-runtime.sh — end-to-end verification of the auth-service against a live
# macp-runtime verifier.
#
# This is OPT-IN and is NOT wired into `npm test`. It requires Docker (and
# grpcurl) and stands up a real runtime, so it is not appropriate for the
# repo's current CI, which has no runtime-image contract. Run it by hand when
# validating that the wiring snippets in docs/ are true against the real binary.
#
# What it proves (all against runtime >= 0.5.0):
#   1. An RS256 token minted here is accepted by the runtime (RS256 in the
#      default MACP_AUTH_JWT_ALGS allowlist, JWKS fetch works, kid fast path,
#      iss/aud match, dev-gate satisfied by JWT config alone).
#   2. The same holds for ES256 (MACP_AUTH_SIGNING_ALG=ES256).
#   3. A garbage bearer is rejected with UNAUTHENTICATED — proving no dev-mode
#      "accept any token" fallback leaked in (the v0.5.0 gate change).
#
# expect_accept/expect_reject probe with ListSessions, not Initialize:
# Initialize never calls authenticate_metadata (confirmed by source read +
# full git history of macp-runtime's src/server.rs — no auth check was ever
# added to it, in any version), so it would accept any bearer, valid or
# garbage, and could never actually prove 1-3 above. ListSessions checks auth
# as its first statement, before request-shape validation.
#
# PROTO RESOLUTION (see ASSUMPTIONS.md / DECISIONS.md): expect_accept/expect_reject
# resolve macp.v1.MACPRuntimeService client-side via grpcurl -import-path/-proto,
# not gRPC server reflection — so this script needs nothing from the target
# image beyond the plain RPC surface, and passes fully end-to-end (RS256 accept,
# ES256 accept, garbage reject) against the real, default, published
# MACP_RUNTIME_IMAGE with no local build required. See resolve_proto_dir()
# below for where the .proto files come from. (macp-runtime separately gained
# opt-in gRPC reflection support of its own — issues #186/#187, PR #188 — but
# this script never needed it and doesn't depend on it either way.)
#
# Manual follow-up (NOT automated here — a timed 1 h grace window is not
# proportionate to automate): stale-cache-grace probe.
#   a. Start with an ephemeral auth-service key; mint a token; confirm accept.
#   b. Restart the auth-service so it generates a NEW ephemeral key, then STOP
#      its container so the JWKS route is unreachable.
#   c. Present a token signed by the OLD key: on runtime >= 0.5.0 it should keep
#      verifying for up to MACP_AUTH_JWKS_TTL_SECS + 3600 s while the runtime
#      logs the warn-level "JWKS refresh failed; serving stale cached keys" line.
#   d. Restart the runtime -> the grace cache is cleared and the old-key token
#      is rejected immediately (the hard cutoff).
#
# Requirements:
#   - docker
#   - grpcurl (https://github.com/fullstorydev/grpcurl)
#   - node + this repo's deps installed (npm ci) to run the auth-service
#
# Config (override via env):
#   MACP_RUNTIME_IMAGE     default: ghcr.io/multiagentcoordinationprotocol/macp-runtime:latest
#   MACP_RUNTIME_BIN       if set, run this local runtime binary instead of the image
#   RUNTIME_GRPC_PORT      default: 50051
#   AUTH_PORT              default: 3200
#   MACP_PROTO_DIR         if set, use this dir (must contain macp/v1/{envelope,core,policy}.proto)
#                          instead of resolving one; highest priority, fails fast if incomplete
#   MACP_PROTO_VERSION     git tag in the multiagentcoordinationprotocol schema repo to fetch
#                          the .proto files from when no sibling checkout/override is used;
#                          default: proto-v0.1.10 (matches macp-runtime's current macp-proto pin,
#                          Cargo.toml:65)
#   MACP_PROTO_SKIP_SIBLING  set to 1 to force the network-fetch path even when a sibling
#                          ../multiagentcoordinationprotocol checkout is present (test-only knob)
#
set -euo pipefail

MACP_RUNTIME_IMAGE="${MACP_RUNTIME_IMAGE:-ghcr.io/multiagentcoordinationprotocol/macp-runtime:latest}"
RUNTIME_GRPC_PORT="${RUNTIME_GRPC_PORT:-50051}"
AUTH_PORT="${AUTH_PORT:-3200}"
NET_NAME="macp-e2e-$$"
AUTH_NAME="macp-e2e-auth-$$"
RUNTIME_NAME="macp-e2e-runtime-$$"

ISSUER="macp-auth-service"
AUDIENCE="macp-runtime"

log()  { printf '\033[1;34m[e2e]\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31m[e2e] FAIL:\033[0m %s\n' "$*" >&2; exit 1; }

need() { command -v "$1" >/dev/null 2>&1 || fail "missing required tool: $1"; }
need docker
need grpcurl
need node
need curl

AUTH_PID=""
PROTO_TMP_DIR=""
cleanup() {
  set +e
  [ -n "${AUTH_PID}" ] && kill "${AUTH_PID}" 2>/dev/null
  docker rm -f "${RUNTIME_NAME}" >/dev/null 2>&1
  docker network rm "${NET_NAME}" >/dev/null 2>&1
  [ -n "${PROTO_TMP_DIR}" ] && rm -rf "${PROTO_TMP_DIR}"
}
trap cleanup EXIT

# ---------------------------------------------------------------------------
# Resolve macp.v1's .proto files so grpcurl can describe
# macp.v1.MACPRuntimeService client-side (see PROTO RESOLUTION above). Priority:
# explicit MACP_PROTO_DIR override > sibling ../../multiagentcoordinationprotocol
# checkout (this workspace's convention) > network fetch pinned to
# MACP_PROTO_VERSION. Sets the global PROTO_DIR.
#
# core.proto is the only file grpcurl needs to be told about directly — it
# imports envelope.proto and policy.proto (core.proto:5-6), and grpcurl
# resolves those transitively from -import-path; neither of those two imports
# anything further. This mirrors exactly the 3-file set macp-runtime's own
# build.rs compiles for the same service.
# ---------------------------------------------------------------------------
proto_files_present() {
  local dir="$1"
  [ -f "${dir}/macp/v1/envelope.proto" ] && \
  [ -f "${dir}/macp/v1/core.proto" ] && \
  [ -f "${dir}/macp/v1/policy.proto" ]
}

PROTO_DIR=""
resolve_proto_dir() {
  if [ -n "${MACP_PROTO_DIR:-}" ]; then
    proto_files_present "${MACP_PROTO_DIR}" \
      || fail "MACP_PROTO_DIR=${MACP_PROTO_DIR} is missing one of macp/v1/{envelope,core,policy}.proto"
    log "proto resolution: using MACP_PROTO_DIR override (${MACP_PROTO_DIR})"
    PROTO_DIR="${MACP_PROTO_DIR}"
    return 0
  fi

  local sibling
  sibling="$(dirname "$0")/../../multiagentcoordinationprotocol/schemas/proto"
  if [ "${MACP_PROTO_SKIP_SIBLING:-}" != "1" ] && proto_files_present "${sibling}"; then
    log "proto resolution: using sibling checkout (${sibling})"
    PROTO_DIR="${sibling}"
    return 0
  fi

  local version="${MACP_PROTO_VERSION:-proto-v0.1.10}"
  # Reject anything that could make curl's own path normalization retarget the
  # fetch outside multiagentcoordinationprotocol/multiagentcoordinationprotocol
  # (e.g. a `../../other-org/other-repo` value) before it ever reaches the URL.
  case "${version}" in
    *..*|/*|*[!A-Za-z0-9._/-]*)
      fail "MACP_PROTO_VERSION=${version} is not a safe git ref (expected [A-Za-z0-9._/-]+, no '..' or leading '/')" ;;
  esac
  local base="https://raw.githubusercontent.com/multiagentcoordinationprotocol/multiagentcoordinationprotocol/${version}/schemas/proto/macp/v1"
  log "proto resolution: no override/sibling checkout; fetching macp.v1 .proto files at ${version}"
  PROTO_TMP_DIR="$(mktemp -d)"
  mkdir -p "${PROTO_TMP_DIR}/macp/v1"
  local f
  for f in envelope.proto core.proto policy.proto; do
    curl -fsS "${base}/${f}" -o "${PROTO_TMP_DIR}/macp/v1/${f}" \
      || fail "failed to fetch ${f} from ${base} (network unreachable, or ${version} doesn't exist in multiagentcoordinationprotocol/multiagentcoordinationprotocol)"
  done
  PROTO_DIR="${PROTO_TMP_DIR}"
}

# ---------------------------------------------------------------------------
# Start the auth-service on the host and expose it to the runtime container.
# We run it on the host (simplest for an ephemeral-key run) and point the
# runtime at host.docker.internal so its JWKS fetch reaches us.
# ---------------------------------------------------------------------------
start_auth() {
  local alg="$1"
  log "starting auth-service (alg=${alg}) on :${AUTH_PORT}"
  MACP_AUTH_SIGNING_ALG="${alg}" \
  MACP_AUTH_ISSUER="${ISSUER}" \
  MACP_AUTH_AUDIENCE="${AUDIENCE}" \
  PORT="${AUTH_PORT}" \
    node "$(dirname "$0")/../dist/index.js" >/tmp/${AUTH_NAME}.log 2>&1 &
  AUTH_PID=$!
  for _ in $(seq 1 30); do
    if curl -fsS "http://127.0.0.1:${AUTH_PORT}/healthz" >/dev/null 2>&1; then return 0; fi
    sleep 0.2
  done
  cat /tmp/${AUTH_NAME}.log >&2 || true
  fail "auth-service did not become healthy"
}

stop_auth() {
  [ -n "${AUTH_PID}" ] && kill "${AUTH_PID}" 2>/dev/null || true
  AUTH_PID=""
}

start_runtime() {
  log "starting runtime ${MACP_RUNTIME_IMAGE} on :${RUNTIME_GRPC_PORT}"
  docker rm -f "${RUNTIME_NAME}" >/dev/null 2>&1 || true
  # Dev-gate is satisfied by JWT auth config alone; MACP_ALLOW_INSECURE=1 here is
  # only for plaintext gRPC in this local probe.
  docker run -d --name "${RUNTIME_NAME}" \
    --add-host host.docker.internal:host-gateway \
    -p "${RUNTIME_GRPC_PORT}:${RUNTIME_GRPC_PORT}" \
    -e MACP_AUTH_ISSUER="${ISSUER}" \
    -e MACP_AUTH_AUDIENCE="${AUDIENCE}" \
    -e MACP_AUTH_JWKS_URL="http://host.docker.internal:${AUTH_PORT}/.well-known/jwks.json" \
    -e MACP_AUTH_JWKS_TTL_SECS=60 \
    -e MACP_AUTH_JWT_ALGS="RS256,ES256" \
    -e MACP_ALLOW_INSECURE=1 \
    -e MACP_BIND_ADDR="0.0.0.0:${RUNTIME_GRPC_PORT}" \
    "${MACP_RUNTIME_IMAGE}" >/dev/null
  # Plain TCP-connect readiness check: the published runtime image does not serve
  # the gRPC reflection API (`grpcurl ... list` fails with "server does not
  # support the reflection API" even once fully up), so reflection can't be used
  # as a liveness probe here. A bare connect is sufficient — the real protocol-level
  # checks are expect_accept/expect_reject below, which call the actual RPC.
  # Note: Docker's -p publisher can accept a connection slightly before the
  # runtime process inside the container finishes binding; harmless here since
  # expect_accept/expect_reject retry-free calls would themselves surface a
  # premature connection as a clear failure, not a false pass.
  for _ in $(seq 1 50); do
    if (exec 3<>"/dev/tcp/127.0.0.1/${RUNTIME_GRPC_PORT}") 2>/dev/null; then return 0; fi
    sleep 0.2
  done
  docker logs "${RUNTIME_NAME}" >&2 || true
  fail "runtime did not become reachable on :${RUNTIME_GRPC_PORT}"
}

mint() {
  curl -fsS -X POST "http://127.0.0.1:${AUTH_PORT}/tokens" \
    -H 'content-type: application/json' \
    -d '{"sender":"agent://e2e","scopes":{"can_start_sessions":true}}' \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).token))'
}

# ListSessions, not Initialize, is the auth probe: Initialize never calls
# authenticate_metadata (confirmed by source read + full git history of
# src/server.rs — no auth check was ever added to it, in any runtime version),
# so it accepts *any* bearer, valid or garbage, as long as
# supported_protocol_versions is populated. ListSessions checks auth as its
# first statement, deliberately before request-shape validation
# (src/server.rs:1274-1278), and takes an all-optional request ({} is valid:
# page_size=0 means server-chosen default, page_token="" means first page).
LIST_SESSIONS_BODY='{}'

# Expect a successful ListSessions with the given bearer.
expect_accept() {
  local token="$1" label="$2"
  if grpcurl -plaintext \
      -import-path "${PROTO_DIR}" -proto macp/v1/core.proto \
      -H "authorization: Bearer ${token}" -d "${LIST_SESSIONS_BODY}" \
      "127.0.0.1:${RUNTIME_GRPC_PORT}" macp.v1.MACPRuntimeService/ListSessions >/dev/null 2>/tmp/${RUNTIME_NAME}.err; then
    log "PASS: ${label} accepted"
  else
    cat /tmp/${RUNTIME_NAME}.err >&2 || true
    fail "${label}: expected acceptance, got rejection"
  fi
}

# Expect an UNAUTHENTICATED rejection with the given bearer.
expect_reject() {
  local token="$1" label="$2"
  if grpcurl -plaintext \
      -import-path "${PROTO_DIR}" -proto macp/v1/core.proto \
      -H "authorization: Bearer ${token}" -d "${LIST_SESSIONS_BODY}" \
      "127.0.0.1:${RUNTIME_GRPC_PORT}" macp.v1.MACPRuntimeService/ListSessions >/dev/null 2>/tmp/${RUNTIME_NAME}.err; then
    fail "${label}: expected UNAUTHENTICATED, but call succeeded"
  fi
  if grep -qi 'Unauthenticated' /tmp/${RUNTIME_NAME}.err; then
    log "PASS: ${label} rejected with UNAUTHENTICATED"
  else
    cat /tmp/${RUNTIME_NAME}.err >&2 || true
    fail "${label}: rejected but not with UNAUTHENTICATED"
  fi
}

# Build the compiled service once so `node dist/index.js` is available.
if [ ! -f "$(dirname "$0")/../dist/index.js" ]; then
  log "building auth-service (npm run build)"
  ( cd "$(dirname "$0")/.." && npm run build >/dev/null )
fi

# Resolve macp.v1's .proto files once, before starting anything — no need to
# re-resolve per runtime instance below.
resolve_proto_dir

# --- RS256 path ---
start_auth RS256
start_runtime
RS_TOKEN="$(mint)"
expect_accept "${RS_TOKEN}" "RS256 token"
expect_reject "not-a-real.jwt.token" "garbage bearer"
docker rm -f "${RUNTIME_NAME}" >/dev/null 2>&1 || true
stop_auth

# --- ES256 path ---
start_auth ES256
start_runtime
ES_TOKEN="$(mint)"
expect_accept "${ES_TOKEN}" "ES256 token"
stop_auth

log "ALL CHECKS PASSED"
