import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import { exportJWK, generateKeyPair } from 'jose';

const envPath = '.env';
const privateJwkPath = 'secrets/router-private-jwk.json';

try {
  await fs.access(envPath);
  console.error(`${envPath} already exists; refusing to overwrite it.`);
  process.exit(1);
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}

const { privateKey, publicKey } = await generateKeyPair('ES256', { extractable: true });
const kid = crypto.randomUUID();
const claimSecret = crypto.randomBytes(32).toString('base64url');
const streamTokenSecret = crypto.randomBytes(32).toString('base64url');
const outboxEncryptionKey = crypto.randomBytes(32).toString('base64');
const privateJwk = await exportJWK(privateKey);
const publicJwk = await exportJWK(publicKey);

for (const jwk of [privateJwk, publicJwk]) {
  jwk.kid = kid;
  jwk.alg = 'ES256';
  jwk.use = 'sig';
}

await fs.mkdir('secrets', { recursive: true });
await fs.writeFile(privateJwkPath, `${JSON.stringify(privateJwk, null, 2)}\n`, { mode: 0o600 });

const env = [
  'NODE_ENV=development',
  'HOST=127.0.0.1',
  'PORT=8787',
  '',
  'ROUTER_AUTH_MODE=jwt',
  'ROUTER_JWT_ALG=ES256',
  'ROUTER_JWT_ISSUER=supabase-edge:replace-with-project-ref',
  'ROUTER_JWT_AUDIENCE=cli-router',
  `ROUTER_JWT_PUBLIC_JWK=${JSON.stringify(publicJwk)}`,
  'ROUTER_JWT_MAX_AGE_SECONDS=60',
  'ROUTER_JWT_CLOCK_TOLERANCE_SECONDS=5',
  '',
  'CORS_ALLOWED_ORIGINS=https://www.example.com,https://example.com',
  'CORS_MAX_AGE_SECONDS=600',
  '',
  'ROUTER_CALLBACK_URL=',
  'ROUTER_CALLBACK_SECRET=',
  'ROUTER_CALLBACK_TIMEOUT_MS=5000',
  'ROUTER_CALLBACK_MAX_ATTEMPTS=3',
  '',
  'ENABLE_BACKGROUND_JOBS=false',
  'ROUTER_PUBLIC_URL=https://router.example.com',
  'ROUTER_PROJECT_ID=replace-with-project-ref',
  'ROUTER_CLAIM_URL=https://replace-with-project-ref.supabase.co/functions/v1/router-claim',
  `ROUTER_CLAIM_SECRET=${claimSecret}`,
  'ROUTER_CLAIM_TIMEOUT_MS=10000',
  'ROUTER_CLAIM_MAX_ATTEMPTS=3',
  `ROUTER_STREAM_TOKEN_SECRET=${streamTokenSecret}`,
  'ROUTER_STREAM_TOKEN_ISSUER=cli-router',
  'ROUTER_STREAM_TOKEN_AUDIENCE=mirastral-stream',
  'ROUTER_STREAM_TOKEN_TTL_SECONDS=60',
  `ROUTER_OUTBOX_ENCRYPTION_KEY=${outboxEncryptionKey}`,
  'ROUTER_OUTBOX_DIR=/var/lib/cli-router/outbox',
  'ROUTER_OUTBOX_RETENTION_MS=86400000',
  'ROUTER_OUTBOX_RETRY_INTERVAL_MS=5000',
  'ROUTER_MAX_ACTIVE_PER_USER=1',
  'ROUTER_LAUNCHES_PER_MINUTE=6',
  'ROUTER_CANCEL_COOLDOWN_MS=3000',
  'ROUTER_MAX_OUTPUT_TOKENS=16384',
  'ROUTER_HEARTBEAT_MS=30000',
  'ROUTER_TERMINAL_RETENTION_MS=900000',
  '',
  'ENABLE_CLAUDE=true',
  'ENABLE_CODEX=true',
  'ENABLE_CODEX_LIVE_SEARCH=true',
  'CLAUDE_BIN=claude',
  'CODEX_BIN=codex',
  'MODEL_REGISTRY_PATH=./config/models.json',
  'DEFAULT_MODEL=claude-sonnet-latest',
  '',
  'RUN_TIMEOUT_MS=600000',
  'MEMORY_RUN_TIMEOUT_MS=600000',
  'MAX_REQUEST_BYTES=31457280',
  'MAX_CONCURRENT_RUNS=2',
  'TMP_DIR=/tmp/cli-router',
  'IMAGE_PROMPT_TOKEN_ESTIMATE=258',
  'IMAGE_PROMPT_TILE_TOKENS=258',
  'IMAGE_PROMPT_SMALL_MAX_PIXELS=384',
  'IMAGE_PROMPT_TILE_SIZE=768',
  'IMAGE_PROMPT_MAX_TOKENS=0',
  '',
  'ALLOWED_FILE_URI_HOSTS=.supabase.co',
  'ALLOW_INSECURE_FILE_URIS=false',
  'ATTACHMENT_DOWNLOAD_TIMEOUT_MS=10000',
  'MAX_IMAGE_BYTES=15728640',
  'MAX_DOC_BYTES=10485760',
  'MAX_PDF_BYTES=10485760',
  'MAX_DOC_TEXT_CHARS=50000',
  '',
  'ALLOWED_IMAGE_MIME=image/png,image/jpeg,image/webp',
  'ALLOWED_DOC_MIME=application/json,text/plain,application/pdf',
  ''
].join('\n');

await fs.writeFile(envPath, env, { mode: 0o600 });

console.log(`wrote ${envPath}`);
console.log(`wrote ${privateJwkPath}`);
console.log('Replace ROUTER_JWT_ISSUER after linking your Supabase project.');
