import fs from 'node:fs/promises';

const envPath = '.env';
const source = await fs.readFile(envPath, 'utf8');
const values = new Map();
for (const line of source.split(/\r?\n/)) {
  const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
  if (match) values.set(match[1], match[2]);
}

const issuer = values.get('ROUTER_JWT_ISSUER') || '';
const projectRef = process.argv[2] || issuer.match(/^supabase-edge:([a-z0-9]{20})$/)?.[1] || '';
if (!/^[a-z0-9]{20}$/.test(projectRef)) {
  throw new Error('Pass the 20-character Supabase project ref');
}
if (!issuer) throw new Error('ROUTER_JWT_ISSUER is required');
const publicJwk = JSON.parse(values.get('ROUTER_JWT_PUBLIC_JWK') || 'null');
if (!publicJwk?.kid || publicJwk.d) throw new Error('ROUTER_JWT_PUBLIC_JWK must be a public JWK with kid');
const allowedOrigins = (values.get('CORS_ALLOWED_ORIGINS') || '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);
const client = [{
  clientId: projectRef,
  projectRef,
  issuer,
  audience: values.get('ROUTER_JWT_AUDIENCE') || 'cli-router',
  publicJwk,
  allowedOrigins,
  allowedModels: ['*'],
  quota: {
    launchesPerMinute: Number(values.get('ROUTER_LAUNCHES_PER_MINUTE') || 6),
    maxActivePerUser: Number(values.get('ROUTER_MAX_ACTIVE_PER_USER') || 1)
  }
}];
const encoded = JSON.stringify(client);
const lines = source.split(/\r?\n/);
const index = lines.findIndex((line) => line.startsWith('ROUTER_TRUSTED_CLIENTS_JSON='));
if (index >= 0) lines[index] = `ROUTER_TRUSTED_CLIENTS_JSON=${encoded}`;
else lines.push(`ROUTER_TRUSTED_CLIENTS_JSON=${encoded}`);
await fs.writeFile(envPath, `${lines.join('\n').replace(/\n+$/, '')}\n`, { mode: 0o600 });
await fs.chmod(envPath, 0o600);
console.log(`Trusted-client registry configured for ${projectRef}; no private key was written.`);
