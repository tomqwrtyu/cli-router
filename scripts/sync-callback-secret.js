import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import dotenv from 'dotenv';

const values = dotenv.parse(fs.readFileSync('.env'));
const callbackSecret = values.ROUTER_CALLBACK_SECRET;
const issuer = values.ROUTER_JWT_ISSUER || '';
const projectRef = process.argv[2] || issuer.split(':').at(-1);

if (!callbackSecret || Buffer.byteLength(callbackSecret) < 32) {
  throw new Error('ROUTER_CALLBACK_SECRET must be configured in .env first');
}
if (!projectRef || projectRef === issuer) {
  throw new Error('Pass a Supabase project ref or configure ROUTER_JWT_ISSUER');
}

const result = spawnSync(
  'npx',
  ['supabase', 'secrets', 'set', `ROUTER_CALLBACK_SECRET=${callbackSecret}`, '--project-ref', projectRef],
  {
    stdio: 'inherit',
    env: { ...process.env, DO_NOT_TRACK: '1' }
  }
);

if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);

console.log('Synced ROUTER_CALLBACK_SECRET without printing its value.');
