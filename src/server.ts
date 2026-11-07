import express, { Express, NextFunction, Request, Response } from 'express';
import { createHash, timingSafeEqual } from 'node:crypto';
import * as jose from 'jose';
import type { AuthServiceConfig } from './config';
import type { SigningMaterial } from './keys';

/** Scope claims embedded in the JWT under `macp_scopes`. */
export interface MintScopes {
  can_start_sessions?: boolean;
  can_manage_mode_registry?: boolean;
  is_observer?: boolean;
  allowed_modes?: string[];
  max_open_sessions?: number;
}

export interface MintRequestBody {
  sender: string;
  scopes?: MintScopes;
  ttl_seconds?: number;
}

export interface MintResponseBody {
  token: string;
  sender: string;
  expires_in_seconds: number;
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

/**
 * True when `presented` equals one of `keys`. Both sides are hashed first so `timingSafeEqual`
 * always compares equal-length buffers (no length leak), and every key is compared so the time
 * taken does not reveal which one matched.
 */
export function matchesIssuerKey(presented: string, keys: readonly string[]): boolean {
  const candidate = digest(presented);
  let matched = false;
  for (const key of keys) {
    matched = timingSafeEqual(candidate, digest(key)) || matched;
  }
  return matched;
}

/**
 * Gate for credential-minting routes. With no keys configured (dev/test only — production
 * refuses to boot, see `assertProductionConfig`) it lets every request through.
 */
function requireIssuerKey(keys: readonly string[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (keys.length === 0) {
      next();
      return;
    }
    const header = req.headers.authorization ?? '';
    const presented = header.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : '';
    if (presented.length === 0 || !matchesIssuerKey(presented, keys)) {
      res.setHeader('WWW-Authenticate', 'Bearer realm="macp-auth-service"');
      res.status(401).json({ error: 'missing or invalid token-issuer key' });
      return;
    }
    next();
  };
}

/**
 * Build the Express app with its routes bound to a specific configuration
 * + signing material. Kept pure (no env reads, no listen) so tests can drive
 * the HTTP surface directly with supertest and so multiple instances can
 * coexist in a single process.
 */
export function createApp(config: AuthServiceConfig, signing: SigningMaterial): Express {
  const app = express();

  app.get('/healthz', (_req: Request, res: Response) => {
    res.json({ ok: true });
  });

  app.get('/.well-known/jwks.json', (_req: Request, res: Response) => {
    res.json(signing.jwks);
  });

  // The key check runs before body parsing, so an unauthenticated caller learns nothing about
  // request validation.
  app.post('/tokens', requireIssuerKey(config.tokenIssuerKeys), express.json(), async (req: Request, res: Response) => {
    const body = req.body as Partial<MintRequestBody> | undefined;

    if (!body || typeof body.sender !== 'string' || body.sender.trim().length === 0) {
      res.status(400).json({ error: 'sender is required' });
      return;
    }

    // The runtime deserializes macp_scopes into a struct; a non-object here would
    // mint a token the runtime rejects, so fail fast at the mint boundary instead.
    const scopes = body.scopes;
    if (scopes !== undefined && (typeof scopes !== 'object' || scopes === null || Array.isArray(scopes))) {
      res.status(400).json({ error: 'scopes must be an object' });
      return;
    }

    const ttlCandidate = body.ttl_seconds ?? config.defaultTtlSeconds;
    if (!Number.isFinite(ttlCandidate) || ttlCandidate <= 0) {
      res.status(400).json({ error: 'ttl_seconds must be a positive number' });
      return;
    }
    const ttl = Math.min(ttlCandidate, config.maxTtlSeconds);

    const token = await new jose.SignJWT({
      macp_scopes: scopes ?? {},
    })
      .setProtectedHeader({ alg: signing.alg, kid: signing.jwks.keys[0]?.kid })
      .setSubject(body.sender)
      .setIssuer(config.issuer)
      .setAudience(config.audience)
      .setIssuedAt()
      .setExpirationTime(`${ttl}s`)
      .sign(signing.privateKey);

    const response: MintResponseBody = {
      token,
      sender: body.sender,
      expires_in_seconds: ttl,
    };
    res.json(response);
  });

  // express.json() throws a SyntaxError with status 400 on malformed bodies;
  // without this handler Express renders it as an HTML error page. It must be
  // registered after the routes because the parser now runs per route.
  app.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (err instanceof SyntaxError && (err as { status?: number }).status === 400) {
      res.status(400).json({ error: 'invalid JSON body' });
      return;
    }
    next(err);
  });

  return app;
}
