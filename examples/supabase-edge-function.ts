import { SignJWT, importJWK } from 'npm:jose@5.9.6'

const ROUTER_URL = Deno.env.get('ROUTER_URL')!
const ROUTER_JWT_PRIVATE_JWK = JSON.parse(Deno.env.get('ROUTER_JWT_PRIVATE_JWK')!)
const ROUTER_JWT_ISSUER = Deno.env.get('ROUTER_JWT_ISSUER')!
const ROUTER_JWT_AUDIENCE = Deno.env.get('ROUTER_JWT_AUDIENCE') || 'cli-router'

async function sha256Hex(body: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', body)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

async function signRouterJwt(path: string, method: string, body: Uint8Array): Promise<string> {
  const key = await importJWK(ROUTER_JWT_PRIVATE_JWK, 'ES256')
  const now = Math.floor(Date.now() / 1000)
  return await new SignJWT({
    sub: 'edge-function',
    method,
    path,
    body_sha256: await sha256Hex(body)
  })
    .setProtectedHeader({ alg: 'ES256', typ: 'JWT', kid: ROUTER_JWT_PRIVATE_JWK.kid })
    .setIssuer(ROUTER_JWT_ISSUER)
    .setAudience(ROUTER_JWT_AUDIENCE)
    .setIssuedAt(now)
    .setExpirationTime(now + 60)
    .setJti(crypto.randomUUID())
    .sign(key)
}

Deno.serve(async (req) => {
  // Validate the user Supabase JWT and app quota before this point.
  // Do not forward the user's Supabase session token to cli-router.
  const body = new Uint8Array(await req.arrayBuffer())
  const path = '/v1beta/models/claude-sonnet:streamGenerateContent'
  const token = await signRouterJwt(path, 'POST', body)

  return fetch(`${ROUTER_URL}${path}?alt=sse`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json'
    },
    body
  })
})
