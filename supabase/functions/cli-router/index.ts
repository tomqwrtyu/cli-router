import { SignJWT, importJWK } from 'npm:jose@5.9.6'

const ROUTER_URL = Deno.env.get('ROUTER_URL')
const ROUTER_JWT_PRIVATE_JWK = Deno.env.get('ROUTER_JWT_PRIVATE_JWK')
const ROUTER_JWT_ISSUER = Deno.env.get('ROUTER_JWT_ISSUER')
const ROUTER_JWT_AUDIENCE = Deno.env.get('ROUTER_JWT_AUDIENCE') || 'cli-router'
const ALLOWED_ORIGINS = (Deno.env.get('ALLOWED_ORIGINS') || '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean)

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

function corsHeaders(origin: string | null): HeadersInit {
  const allowedOrigin = ALLOWED_ORIGINS.length === 0
    ? (origin || '*')
    : (origin && ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0])

  return {
    'access-control-allow-origin': allowedOrigin,
    'access-control-allow-headers': 'authorization, x-client-info, apikey, content-type',
    'access-control-allow-methods': 'POST, GET, OPTIONS',
    vary: 'origin'
  }
}

function routerPathFromRequest(req: Request): string {
  const url = new URL(req.url)
  const match = url.pathname.match(/\/cli-router(?<path>\/.*)?$/)
  return match?.groups?.path || '/v1beta/models'
}

Deno.serve(async (req) => {
  const origin = req.headers.get('origin')
  const cors = corsHeaders(origin)

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: cors })
  }

  const routerPath = routerPathFromRequest(req)
  const incomingUrl = new URL(req.url)
  const routerUrl = new URL(routerPath, ROUTER_URL)
  routerUrl.search = incomingUrl.search

  const body = req.method === 'GET' ? new Uint8Array() : new Uint8Array(await req.arrayBuffer())
  const token = await signRouterJwt(routerUrl.pathname, req.method, body)

  const upstream = await fetch(routerUrl, {
    method: req.method,
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': req.headers.get('content-type') || 'application/json',
      accept: req.headers.get('accept') || '*/*'
    },
    body: req.method === 'GET' ? undefined : body
  })

  const headers = new Headers(upstream.headers)
  for (const [key, value] of Object.entries(cors)) {
    headers.set(key, value)
  }

  return new Response(upstream.body, {
    status: upstream.status,
    headers
  })
})
