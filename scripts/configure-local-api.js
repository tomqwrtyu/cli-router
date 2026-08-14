import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const [clientId = 'life', modelList = '', rawPort = '8788'] = process.argv.slice(2);
if (!/^[A-Za-z0-9_-]{1,80}$/.test(clientId)) {
  throw new Error('Client ID must contain only letters, numbers, underscores, and hyphens');
}
const port = Number.parseInt(rawPort, 10);
if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error('Port must be an integer from 1 to 65535');
}

const models = modelList.split(',').map((model) => model.trim()).filter(Boolean);
if (models.length === 0) {
  throw new Error('Usage: node scripts/configure-local-api.js <client-id> <comma-separated-models> [port]');
}
const registry = JSON.parse(await fs.readFile('config/models.json', 'utf8'));
for (const model of models) {
  if (!registry[model]) throw new Error(`Unknown model ID: ${model}`);
}

const envPath = '.env';
const source = await fs.readFile(envPath, 'utf8');
const currentToken = /^ROUTER_LOCAL_API_TOKEN=(.+)$/m.exec(source)?.[1]?.trim();
const token = currentToken && !currentToken.startsWith('replace-')
  ? currentToken
  : crypto.randomBytes(32).toString('base64url');
const tokenDir = 'secrets';
const tokenPath = path.join(tokenDir, `local-api-${clientId}.token`);

const updates = new Map([
  ['ROUTER_LOCAL_API_ENABLED', 'true'],
  ['ROUTER_LOCAL_API_HOST', '127.0.0.1'],
  ['ROUTER_LOCAL_API_PORT', String(port)],
  ['ROUTER_LOCAL_API_TOKEN', token],
  ['ROUTER_LOCAL_API_CLIENT_ID', clientId],
  ['ROUTER_LOCAL_ALLOWED_MODELS', models.join(',')]
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

await fs.mkdir(tokenDir, { recursive: true, mode: 0o700 });
await fs.writeFile(tokenPath, `${token}\n`, { mode: 0o600 });
await fs.chmod(tokenPath, 0o600);
await fs.writeFile(envPath, `${lines.join('\n').replace(/\n+$/, '')}\n`, { mode: 0o600 });
await fs.chmod(envPath, 0o600);

console.log(`Configured loopback API at http://127.0.0.1:${port}`);
console.log(`Client token written to ${tokenPath}; it was not printed.`);
console.log(`Allowed models: ${models.join(', ')}`);
