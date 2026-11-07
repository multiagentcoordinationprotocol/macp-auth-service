import { assertProductionConfig, loadConfigFromEnv } from './config';
import { loadKey } from './keys';
import { createApp } from './server';

async function main(): Promise<void> {
  const config = loadConfigFromEnv();
  assertProductionConfig(config);
  const signing = await loadKey(config.signingKeyJson, config.signingAlg);
  const app = createApp(config, signing);

  const server = app.listen(config.port, () => {
    console.log(`[auth-service] listening on port ${config.port}`);
    console.log(`[auth-service] issuer=${config.issuer} audience=${config.audience}`);
    console.log(`[auth-service] key source: ${signing.source} alg: ${signing.alg}`);
    console.log(`[auth-service] JWKS: http://localhost:${config.port}/.well-known/jwks.json`);
    console.log(`[auth-service] Mint: POST http://localhost:${config.port}/tokens`);
    if (config.tokenIssuerKeys.length === 0) {
      console.warn('[auth-service] TOKEN_ISSUER_KEYS is empty: POST /tokens accepts unauthenticated callers (dev/test only)');
    } else {
      console.log(`[auth-service] POST /tokens requires a token-issuer key (${config.tokenIssuerKeys.length} configured)`);
    }
  });

  const shutdown = (sig: string): void => {
    console.log(`[auth-service] ${sig} received; shutting down`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

void main().catch((err: unknown) => {
  console.error('[auth-service] fatal', err);
  process.exit(1);
});
