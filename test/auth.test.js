import assert from 'node:assert/strict';
import test from 'node:test';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { clientAllowsModel, createJwtVerifier, createLocalTokenVerifier, sha256Hex } from '../src/auth.js';

async function fixture() {
  const { publicKey, privateKey } = await generateKeyPair('ES256');
  const publicJwk = { ...await exportJWK(publicKey), kid: 'project-a-key' };
  const now = Math.floor(Date.now() / 1000);
  const body = Buffer.from('{}');
  const token = await new SignJWT({
    method: 'POST',
    path: '/v1/jobs',
    body_sha256: sha256Hex(body),
    client_id: 'project-a',
    project_ref: 'abcdefghijklmnopqrst'
  })
    .setProtectedHeader({ alg: 'ES256', kid: publicJwk.kid })
    .setIssuer('supabase-edge:abcdefghijklmnopqrst')
    .setAudience('cli-router')
    .setIssuedAt(now)
    .setExpirationTime(now + 60)
    .setJti(crypto.randomUUID())
    .sign(privateKey);
  const config = {
    authMode: 'jwt',
    env: 'test',
    jwt: { maxAgeSeconds: 60, clockToleranceSeconds: 5 },
    trustedClients: [{
      clientId: 'project-a',
      projectRef: 'abcdefghijklmnopqrst',
      issuer: 'supabase-edge:abcdefghijklmnopqrst',
      audience: 'cli-router',
      alg: 'ES256',
      publicJwk,
      allowedOrigins: ['https://app.example.test'],
      allowedModels: ['gpt-5.6-sol']
    }]
  };
  return { token, body, config };
}

test('trusted-client verifier binds issuer, audience, kid, claims, origin, method, path, and body', async () => {
  const { token, body, config } = await fixture();
  const verify = await createJwtVerifier(config);
  const payload = await verify({
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, origin: 'https://app.example.test' }
  }, new URL('https://router.example.test/v1/jobs'), body);
  assert.equal(payload.routerClient.clientId, 'project-a');
  assert.equal(clientAllowsModel(payload, 'gpt-5.6-sol'), true);
  assert.equal(clientAllowsModel(payload, 'claude-opus-latest'), false);
});

test('trusted-client verifier rejects a client claim mismatch', async () => {
  const { token, body, config } = await fixture();
  config.trustedClients[0].projectRef = 'different-project-ref';
  const verify = await createJwtVerifier(config);
  await assert.rejects(
    () => verify({ method: 'POST', headers: { authorization: `Bearer ${token}` } }, new URL('https://router.example.test/v1/jobs'), body),
    (error) => error.statusCode === 401
  );
});

test('local verifier requires loopback, no browser origin, and the exact token', async () => {
  const verify = createLocalTokenVerifier({
    enabled: true,
    token: 'a'.repeat(32),
    clientId: 'life',
    allowedModels: ['gpt-5.6-luna']
  });
  const request = (overrides = {}) => ({
    headers: { authorization: `Bearer ${'a'.repeat(32)}` },
    socket: { remoteAddress: '127.0.0.1' },
    ...overrides
  });

  const claims = await verify(request());
  assert.equal(claims.localApi, true);
  assert.equal(clientAllowsModel(claims, 'gpt-5.6-luna'), true);
  assert.equal(clientAllowsModel(claims, 'gpt-5.6-sol'), false);

  await assert.rejects(
    () => verify(request({ socket: { remoteAddress: '10.0.0.2' } })),
    (error) => error.statusCode === 403 && error.details.reason === 'local_client_not_loopback'
  );
  await assert.rejects(
    () => verify(request({ headers: {
      authorization: `Bearer ${'a'.repeat(32)}`,
      origin: 'https://example.test'
    } })),
    (error) => error.statusCode === 403 && error.details.reason === 'local_browser_origin_denied'
  );
  await assert.rejects(
    () => verify(request({ headers: { authorization: `Bearer ${'b'.repeat(32)}` } })),
    (error) => error.statusCode === 401
  );
});
