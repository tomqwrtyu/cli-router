import { SignJWT, importJWK } from 'npm:jose@5.9.6'

const ROUTER_URL = Deno.env.get('ROUTER_URL')
const ROUTER_JWT_PRIVATE_JWK = Deno.env.get('ROUTER_JWT_PRIVATE_JWK')
const ROUTER_JWT_ISSUER = Deno.env.get('ROUTER_JWT_ISSUER')
const ROUTER_JWT_AUDIENCE = Deno.env.get('ROUTER_JWT_AUDIENCE') || 'cli-router'

if (!ROUTER_URL) throw new Error('ROUTER_URL is required')
if (!ROUTER_JWT_PRIVATE_JWK) throw new Error('ROUTER_JWT_PRIVATE_JWK is required')
if (!ROUTER_JWT_ISSUER) throw new Error('ROUTER_JWT_ISSUER is required')

const privateJwk = JSON.parse(ROUTER_JWT_PRIVATE_JWK)
const privateKey = await importJWK(privateJwk, 'ES256')

async function sha256Hex(body: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', body)
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

async function signRouterJwt(path: string, method: string, body: Uint8Array): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  return await new SignJWT({
    sub: 'supabase-edge-function',
    method,
    path,
    body_sha256: await sha256Hex(body)
  })
    .setProtectedHeader({ alg: 'ES256', typ: 'JWT', kid: privateJwk.kid })
    .setIssuer(ROUTER_JWT_ISSUER)
    .setAudience(ROUTER_JWT_AUDIENCE)
    .setIssuedAt(now)
    .setExpirationTime(now + 60)
    .setJti(crypto.randomUUID())
    .sign(privateKey)
}

export async function callCliRouter(path: string, body: unknown, init: RequestInit = {}): Promise<Response> {
  const method = init.method || 'POST'
  const rawBody = new TextEncoder().encode(JSON.stringify(body))
  const token = await signRouterJwt(path, method, rawBody)
  const url = new URL(path, ROUTER_URL)

  return fetch(url, {
    ...init,
    method,
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: init.headers instanceof Headers ? init.headers.get('accept') || '*/*' : '*/*',
      ...(init.headers && !(init.headers instanceof Headers) ? init.headers : {})
    },
    body: rawBody
  })
}

export function geminiGeneratePath(model: string): string {
  return `/v1beta/models/${encodeURIComponent(model)}:generateContent`
}

export function geminiStreamPath(model: string): string {
  return `/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`
}
