import { loadConfigFromEnv } from './config';
import { loadKey } from './keys';
import { createApp } from './server';

async function main(): Promise<void> {
  const config = loadConfigFromEnv();
  const signing = await loadKey(config.signingKeyJson);
  const app = createApp(config, signing);

  const server = app.listen(config.port, () => {
    console.log(`[auth-service] listening on port ${config.port}`);
    console.log(`[auth-service] issuer=${config.issuer} audience=${config.audience}`);
    console.log(`[auth-service] key source: ${signing.source}`);
    console.log(`[auth-service] JWKS: http://localhost:${config.port}/.well-known/jwks.json`);
    console.log(`[auth-service] Mint: POST http://localhost:${config.port}/tokens`);
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
