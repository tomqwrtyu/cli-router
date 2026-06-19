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
  'ENABLE_CLAUDE=true',
  'ENABLE_CODEX=true',
  'MODEL_REGISTRY_PATH=./config/models.json',
  'DEFAULT_MODEL=claude-sonnet',
  '',
  'RUN_TIMEOUT_MS=120000',
  'MAX_REQUEST_BYTES=31457280',
  'MAX_CONCURRENT_RUNS=2',
  'TMP_DIR=/tmp/cli-router',
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
