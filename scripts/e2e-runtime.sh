#!/usr/bin/env bash
#
# e2e-runtime.sh — end-to-end verification of the auth-service against a live
# macp-runtime v0.5.0 verifier.
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
#   MACP_RUNTIME_IMAGE   default: ghcr.io/multiagentcoordinationprotocol/macp-runtime:latest
#   MACP_RUNTIME_BIN     if set, run this local runtime binary instead of the image
#   RUNTIME_GRPC_PORT    default: 50051
#   AUTH_PORT            default: 3200
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
cleanup() {
  set +e
  [ -n "${AUTH_PID}" ] && kill "${AUTH_PID}" 2>/dev/null
  docker rm -f "${RUNTIME_NAME}" >/dev/null 2>&1
  docker network rm "${NET_NAME}" >/dev/null 2>&1
}
trap cleanup EXIT

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
  for _ in $(seq 1 50); do
    if grpcurl -plaintext "127.0.0.1:${RUNTIME_GRPC_PORT}" list >/dev/null 2>&1; then return 0; fi
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

# Expect a successful Initialize with the given bearer.
expect_accept() {
  local token="$1" label="$2"
  if grpcurl -plaintext \
      -H "authorization: Bearer ${token}" -d '{}' \
      "127.0.0.1:${RUNTIME_GRPC_PORT}" macp.v1.MACPRuntimeService/Initialize >/dev/null 2>/tmp/${RUNTIME_NAME}.err; then
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
      -H "authorization: Bearer ${token}" -d '{}' \
      "127.0.0.1:${RUNTIME_GRPC_PORT}" macp.v1.MACPRuntimeService/Initialize >/dev/null 2>/tmp/${RUNTIME_NAME}.err; then
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
