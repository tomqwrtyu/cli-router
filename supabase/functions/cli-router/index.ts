import { SignJWT, importJWK } from 'npm:jose@5.9.6'
import { createClient } from 'npm:@supabase/supabase-js'

const ROUTER_URL = Deno.env.get('ROUTER_URL')
const ROUTER_JWT_PRIVATE_JWK = Deno.env.get('ROUTER_JWT_PRIVATE_JWK')
const ROUTER_JWT_ISSUER = Deno.env.get('ROUTER_JWT_ISSUER')
const ROUTER_JWT_AUDIENCE = Deno.env.get('ROUTER_JWT_AUDIENCE') || 'cli-router'
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
const ALLOWED_ORIGINS = (Deno.env.get('ALLOWED_ORIGINS') || '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean)

if (!ROUTER_URL) throw new Error('ROUTER_URL is required')
if (!ROUTER_JWT_PRIVATE_JWK) throw new Error('ROUTER_JWT_PRIVATE_JWK is required')
if (!ROUTER_JWT_ISSUER) throw new Error('ROUTER_JWT_ISSUER is required')
if (!SUPABASE_URL) throw new Error('SUPABASE_URL is required')
if (!SUPABASE_SERVICE_ROLE_KEY) throw new Error('SUPABASE_SERVICE_ROLE_KEY is required')

const privateJwk = JSON.parse(ROUTER_JWT_PRIVATE_JWK)
const privateKey = await importJWK(privateJwk, 'ES256')
const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false }
})

type RouterModel = {
  name: string
  displayName?: string
  supportedGenerationMethods?: string[]
  provider?: string
  supportsImages?: boolean
  access?: {
    visibility?: string
  }
  billing?: Record<string, unknown> | null
}

type UserModelPolicy = {
  allowedModels: Set<string>
  blockedModels: Set<string>
  allowAll: boolean
}

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

function jsonResponse(body: unknown, status: number, cors: HeadersInit): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...cors,
      'content-type': 'application/json'
    }
  })
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const payload = token.split('.')[1]
    const base64 = payload.replace(/-/g, '+').replace(/_/g, '/')
    const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '=')
    return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(padded), (char) => char.charCodeAt(0))))
  } catch {
    return null
  }
}

function userIdFromRequest(req: Request): string | null {
  const header = req.headers.get('authorization') || ''
  const match = /^Bearer\s+(.+)$/i.exec(header)
  if (!match) return null
  const payload = decodeJwtPayload(match[1])
  return typeof payload?.sub === 'string' ? payload.sub : null
}

function modelIdFromRouterPath(path: string): string | null {
  const match = /^\/v1beta\/models\/([^/:]+):(generateContent|streamGenerateContent)$/.exec(path)
  return match?.[1] || null
}

function modelIdFromModelName(name: string): string {
  return name.replace(/^models\//, '')
}

function stringSet(value: unknown): Set<string> {
  return new Set(
    Array.isArray(value)
      ? value
        .map((item: unknown) => typeof item === 'string' ? item.trim() : '')
        .filter(Boolean)
      : []
  )
}

async function getUserModelPolicy(userId: string): Promise<UserModelPolicy> {
  const { data, error } = await supabaseAdmin
    .from('profiles')
    .select('allowed_router_models, blocked_router_models')
    .eq('id', userId)
    .maybeSingle()

  if (error) {
    console.error('Router model policy lookup failed', error)
    throw new Error('Router model policy lookup failed')
  }

  const allowedModels = stringSet(data?.allowed_router_models)
  return {
    allowedModels,
    blockedModels: stringSet(data?.blocked_router_models),
    allowAll: allowedModels.has('*')
  }
}

function modelVisibility(model: RouterModel): string {
  const visibility = model.access?.visibility
  if (visibility === 'default' || visibility === 'restricted' || visibility === 'admin') {
    return visibility
  }
  return 'restricted'
}

function isModelAllowed(policy: UserModelPolicy, model: RouterModel): boolean {
  if (policy.allowAll) return true

  const modelId = modelIdFromModelName(model.name)
  if (policy.blockedModels.has(modelId)) return false

  const visibility = modelVisibility(model)
  if (visibility === 'default') return true
  if (visibility === 'restricted') return policy.allowedModels.has(modelId)
  return false
}

function filterModelsForUser(models: RouterModel[], policy: UserModelPolicy): RouterModel[] {
  return models.filter((model) => isModelAllowed(policy, model))
}

async function fetchRouterModelsPayload(): Promise<{ payload: Record<string, unknown>; models: RouterModel[] }> {
  const body = new Uint8Array()
  const path = '/v1beta/models'
  const token = await signRouterJwt(path, 'GET', body)
  const routerUrl = new URL(path, ROUTER_URL)
  const upstream = await fetch(routerUrl, {
    method: 'GET',
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/json'
    }
  })

  if (!upstream.ok) {
    throw new Error(`Router models fetch failed: ${upstream.status} ${await upstream.text()}`)
  }

  const payload = await upstream.json()
  const models = Array.isArray(payload.models) ? payload.models : []
  return { payload, models }
}

Deno.serve(async (req) => {
  const origin = req.headers.get('origin')
  const cors = corsHeaders(origin)

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: cors })
  }

  const userId = userIdFromRequest(req)
  if (!userId) {
    return jsonResponse({ error: 'Missing authenticated user' }, 401, cors)
  }

  const routerPath = routerPathFromRequest(req)
  const incomingUrl = new URL(req.url)
  const routerUrl = new URL(routerPath, ROUTER_URL)
  routerUrl.search = incomingUrl.search

  const userPolicy = await getUserModelPolicy(userId)
  const requestedModel = modelIdFromRouterPath(routerUrl.pathname)

  if (req.method === 'GET' && routerUrl.pathname === '/v1beta/models') {
    const { payload, models } = await fetchRouterModelsPayload()
    const headers = new Headers()
    for (const [key, value] of Object.entries(cors)) {
      headers.set(key, value)
    }
    headers.set('content-type', 'application/json')

    return new Response(JSON.stringify({ ...payload, models: filterModelsForUser(models, userPolicy) }), {
      status: 200,
      headers
    })
  }

  if (requestedModel) {
    const { models } = await fetchRouterModelsPayload()
    const requestedRouterModel = models.find((model) => modelIdFromModelName(model.name) === requestedModel)
    if (!requestedRouterModel) {
      return jsonResponse({ error: 'Model not enabled' }, 404, cors)
    }
    if (!isModelAllowed(userPolicy, requestedRouterModel)) {
      return jsonResponse({ error: 'Model not allowed' }, 403, cors)
    }
  }

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
