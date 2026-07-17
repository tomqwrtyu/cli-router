import crypto from 'node:crypto';
import fs from 'node:fs/promises';

const [callbackUrl, origins] = process.argv.slice(2);
if (!callbackUrl || !origins) {
  console.error('Usage: node scripts/configure-callback.js <https-callback-url> <comma-separated-origins>');
  process.exit(1);
}

const parsedCallbackUrl = new URL(callbackUrl);
if (parsedCallbackUrl.protocol !== 'https:') {
  throw new Error('Callback URL must use HTTPS');
}

const normalizedOrigins = origins
  .split(',')
  .map((origin) => new URL(origin.trim()).origin)
  .join(',');

const envPath = '.env';
const source = await fs.readFile(envPath, 'utf8');
const existingSecret = /^ROUTER_CALLBACK_SECRET=(.+)$/m.exec(source)?.[1]?.trim();
const callbackSecret = existingSecret && !existingSecret.startsWith('replace-')
  ? existingSecret
  : crypto.randomBytes(32).toString('base64url');

const updates = new Map([
  ['CORS_ALLOWED_ORIGINS', normalizedOrigins],
  ['CORS_MAX_AGE_SECONDS', '600'],
  ['ROUTER_CALLBACK_URL', callbackUrl],
  ['ROUTER_CALLBACK_SECRET', callbackSecret],
  ['ROUTER_CALLBACK_TIMEOUT_MS', '5000'],
  ['ROUTER_CALLBACK_MAX_ATTEMPTS', '3']
]);

const seen = new Set();
const lines = source.split(/\r?\n/).map((line) => {
  const match = /^([A-Z][A-Z0-9_]*)=/.exec(line);
  if (!match || !updates.has(match[1])) return line;
  seen.add(match[1]);
  return `${match[1]}=${updates.get(match[1])}`;
});

for (const [key, value] of updates) {
  if (!seen.has(key)) lines.push(`${key}=${value}`);
}

await fs.writeFile(envPath, `${lines.join('\n').replace(/\n+$/, '')}\n`, { mode: 0o600 });
await fs.chmod(envPath, 0o600);

console.log('Configured exact CORS origins and router callback settings in .env.');
console.log('The callback secret was not printed.');
