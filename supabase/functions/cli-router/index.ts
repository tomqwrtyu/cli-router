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
  contextWindow?: number
  inputCharLimit?: number
  inputTokenLimit?: number
  outputTokenLimit?: number
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
  const allowedOrigin = origin && ALLOWED_ORIGINS.includes(origin) ? origin : null

  return {
    ...(allowedOrigin ? { 'access-control-allow-origin': allowedOrigin } : {}),
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

function userTokenFromRequest(req: Request): string | null {
  const header = req.headers.get('authorization') || ''
  const match = /^Bearer\s+(.+)$/i.exec(header)
  return match?.[1] || null
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

  const userToken = userTokenFromRequest(req)
  if (!userToken) {
    return jsonResponse({ error: 'Missing authenticated user' }, 401, cors)
  }
  const { data: authData, error: authError } = await supabaseAdmin.auth.getUser(userToken)
  const userId = authData.user?.id
  if (authError || !userId) return jsonResponse({ error: 'Invalid authenticated user' }, 401, cors)

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

  if (requestedModel) return jsonResponse({ error: 'Direct generation is disabled' }, 403, cors)
  return jsonResponse({ error: 'Route not found' }, 404, cors)
})
