import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import dotenv from 'dotenv';

const values = dotenv.parse(fs.readFileSync('.env'));
const projectRef = process.argv[2] || values.ROUTER_PROJECT_ID;
const routerPublicUrl = (process.argv[3] || values.ROUTER_PUBLIC_URL || '').replace(/\/+$/, '');
if (!/^[a-z0-9]{20}$/.test(projectRef || '')) {
  throw new Error('Pass a valid Supabase project ref or configure ROUTER_PROJECT_ID');
}
if (!/^https:\/\/[^/]+(?:\/.*)?$/.test(routerPublicUrl)) {
  throw new Error('Pass a public HTTPS Router URL or configure ROUTER_PUBLIC_URL');
}
for (const name of ['ROUTER_CLAIM_SECRET', 'ROUTER_CALLBACK_SECRET']) {
  if (!values[name] || Buffer.byteLength(values[name]) < 32) {
    throw new Error(`${name} must be configured and at least 32 bytes`);
  }
}

const args = [
  'supabase', 'secrets', 'set',
  `ROUTER_CLAIM_SECRET=${values.ROUTER_CLAIM_SECRET}`,
  `ROUTER_CALLBACK_SECRET=${values.ROUTER_CALLBACK_SECRET}`,
  `ROUTER_PROJECT_ID=${projectRef}`,
  `ROUTER_URL=${routerPublicUrl}`,
  `ALLOWED_ORIGINS=${values.CORS_ALLOWED_ORIGINS || ''}`,
  '--project-ref', projectRef,
];
const result = spawnSync('npx', args, {
  stdio: 'inherit',
  env: { ...process.env, DO_NOT_TRACK: '1' },
});
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
console.log('Synced background Edge secrets without printing their values.');
