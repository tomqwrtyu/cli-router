import crypto from 'node:crypto';
import fs from 'node:fs/promises';

const projectRef = process.argv[2] || '';
const routerPublicUrl = process.argv[3] || '';
if (!/^[a-z0-9]{20}$/.test(projectRef)) {
  throw new Error('Usage: node scripts/configure-background.js <supabase-project-ref> <https-router-url>');
}
if (!/^https:\/\/[^/]+(?:\/.*)?$/.test(routerPublicUrl)) {
  throw new Error('Pass the public HTTPS Router URL as the second argument');
}

const envPath = '.env';
const source = await fs.readFile(envPath, 'utf8');
const current = new Map();
for (const line of source.split(/\r?\n/)) {
  const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
  if (match) current.set(match[1], match[2]);
}

const keepOrGenerate = (name, generate) => {
  const value = current.get(name) || '';
  return value && !value.startsWith('replace-') ? value : generate();
};

const updates = new Map([
  ['ENABLE_BACKGROUND_JOBS', 'false'],
  ['ROUTER_PUBLIC_URL', routerPublicUrl.replace(/\/+$/, '')],
  ['ROUTER_PROJECT_ID', projectRef],
  ['ROUTER_CLAIM_URL', `https://${projectRef}.supabase.co/functions/v1/router-claim`],
  ['ROUTER_CLAIM_SECRET', keepOrGenerate('ROUTER_CLAIM_SECRET', () => crypto.randomBytes(32).toString('base64url'))],
  ['ROUTER_CLAIM_TIMEOUT_MS', '10000'],
  ['ROUTER_CLAIM_MAX_ATTEMPTS', '3'],
  ['ROUTER_STREAM_TOKEN_SECRET', keepOrGenerate('ROUTER_STREAM_TOKEN_SECRET', () => crypto.randomBytes(32).toString('base64url'))],
  ['ROUTER_STREAM_TOKEN_ISSUER', 'cli-router'],
  ['ROUTER_STREAM_TOKEN_AUDIENCE', 'mirastral-stream'],
  ['ROUTER_STREAM_TOKEN_TTL_SECONDS', '60'],
  ['ROUTER_OUTBOX_ENCRYPTION_KEY', keepOrGenerate('ROUTER_OUTBOX_ENCRYPTION_KEY', () => crypto.randomBytes(32).toString('base64'))],
  ['ROUTER_OUTBOX_DIR', '/var/lib/cli-router/outbox'],
  ['ROUTER_OUTBOX_RETENTION_MS', '86400000'],
  ['ROUTER_OUTBOX_RETRY_INTERVAL_MS', '5000'],
  ['ROUTER_MAX_ACTIVE_PER_USER', '1'],
  ['ROUTER_LAUNCHES_PER_MINUTE', '6'],
  ['ROUTER_CANCEL_COOLDOWN_MS', '3000'],
  ['ROUTER_MAX_OUTPUT_TOKENS', '16384'],
  ['ROUTER_HEARTBEAT_MS', '30000'],
  ['ROUTER_TERMINAL_RETENTION_MS', '900000'],
  ['RUN_TIMEOUT_MS', '600000'],
  ['MEMORY_RUN_TIMEOUT_MS', '600000'],
  ['ENABLE_CODEX_LIVE_SEARCH', 'true']
]);

const seen = new Set();
const lines = source.split(/\r?\n/).map((line) => {
  const match = /^([A-Z][A-Z0-9_]*)=/.exec(line);
  if (!match || !updates.has(match[1])) return line;
  seen.add(match[1]);
  return `${match[1]}=${updates.get(match[1])}`;
});
for (const [name, value] of updates) {
  if (!seen.has(name)) lines.push(`${name}=${value}`);
}

await fs.writeFile(envPath, `${lines.join('\n').replace(/\n+$/, '')}\n`, { mode: 0o600 });
await fs.chmod(envPath, 0o600);
console.log('Background job settings and local secrets are configured with ENABLE_BACKGROUND_JOBS=false.');
