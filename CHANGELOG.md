# Changelog

All notable changes to the MACP auth-service will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `MACP_AUTH_SIGNING_ALG` (`RS256` default, or `ES256`) to select the signature
  algorithm. `ES256` mints with an EC P-256 key; the JWKS advertises the matching
  `kty: "EC"` public key. The runtime verifier already accepts RS256/ES256/HS256,
  so this is additive and backward compatible. Invalid values fail fast at startup.
- `src/contract.spec.ts` — cross-service contract test that pins the exact
  `macp_scopes` field set and JWT claim shape the runtime's `MACPClaims` /
  `MACPScopes` structs deserialize, run across both RS256 and ES256. Guards
  against silent wire-contract drift between auth-service, runtime, control-plane,
  and examples-service.

- `docs/` directory with long-form documentation: `README.md` (index),
  `getting-started.md`, `integration.md`, `architecture.md`, `API.md`,
  `deployment.md`, and `operations.md`. Style and structure match the
  `runtime/docs` layout so the website can pick both up with the same sync.
  The integration and index pages call out both minter consumers
  (control-plane, SDK-based orchestrators) and bearer consumers
  (TS + Python SDK agents), with cross-links to the corresponding
  control-plane, SDK, and runtime auth docs.
- `.github/workflows/notify-website.yml` — on push to `main` with changes
  under `docs/**` or to `README.md`, dispatches a `docs-updated` event to
  `multiagentcoordinationprotocol/website`.
- Testable factory — `createApp(config, signing)` exported from `src/server.ts`
  so supertest can exercise the HTTP surface without opening a port.
- Jest + supertest unit/integration tests covering `/healthz`,
  `/.well-known/jwks.json`, and `/tokens` (validation, TTL clamp, scope
  round-trip, issuer/audience verification, JWKS signature verification).
- Multi-stage Dockerfile (`node:20-alpine`, non-root `appuser`, HTTP healthcheck).
- GitHub Actions: `ci.yml` (lint + typecheck + test + build) and `docker.yml`
  (build + push to GHCR on PR + main).
- `README.md`, `CLAUDE.md`, `SECURITY.md`, `.env.example`, `.dockerignore`,
  `.gitignore`, `.editorconfig`, `.nvmrc`, `LICENSE` (Apache-2.0).
- Graceful shutdown on `SIGTERM` / `SIGINT`.
- Input validation on `POST /tokens`: rejects empty `sender` and non-positive
  `ttl_seconds` with `400`.

### Changed

- Pinned `jose` to `^5.9.6` (CommonJS-compatible) so jest/ts-jest can test the
  code in the same module system as the production build. All jose APIs used
  here (`generateKeyPair`, `exportJWK`, `importJWK`, `SignJWT`, `jwtVerify`,
  `createLocalJWKSet`) are available in v5.
- Pinned `typescript` to `^5.6.3` and `@types/node` to `^20.x` to align with
  the rest of the monorepo toolchain.

## [1.0.0] — 2026-04-18

Initial prototype. Single-file Express server (`src/index.ts`) with `POST
/tokens`, `GET /.well-known/jwks.json`, and `GET /healthz`. Ephemeral RSA
keypair in dev; `MACP_AUTH_SIGNING_KEY_JSON` for pinned production keys.
