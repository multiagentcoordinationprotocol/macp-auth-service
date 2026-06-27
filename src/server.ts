import express, { Express, Request, Response } from 'express';
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

/**
 * Build the Express app with its routes bound to a specific configuration
 * + signing material. Kept pure (no env reads, no listen) so tests can drive
 * the HTTP surface directly with supertest and so multiple instances can
 * coexist in a single process.
 */
export function createApp(config: AuthServiceConfig, signing: SigningMaterial): Express {
  const app = express();
  app.use(express.json());

  app.get('/healthz', (_req: Request, res: Response) => {
    res.json({ ok: true });
  });

  app.get('/.well-known/jwks.json', (_req: Request, res: Response) => {
    res.json(signing.jwks);
  });

  app.post('/tokens', async (req: Request, res: Response) => {
    const body = req.body as Partial<MintRequestBody> | undefined;

    if (!body || typeof body.sender !== 'string' || body.sender.length === 0) {
      res.status(400).json({ error: 'sender is required' });
      return;
    }

    const ttlCandidate = body.ttl_seconds ?? config.defaultTtlSeconds;
    if (!Number.isFinite(ttlCandidate) || ttlCandidate <= 0) {
      res.status(400).json({ error: 'ttl_seconds must be a positive number' });
      return;
    }
    const ttl = Math.min(ttlCandidate, config.maxTtlSeconds);

    const token = await new jose.SignJWT({
      macp_scopes: body.scopes ?? {},
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

  return app;
}
