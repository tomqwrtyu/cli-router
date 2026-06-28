import fs from 'node:fs/promises';
import path from 'node:path';
import dotenv from 'dotenv';

dotenv.config();

function boolEnv(name, fallback = false) {
  const value = process.env[name];
  if (value == null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

function intEnv(name, fallback) {
  const value = process.env[name];
  if (value == null || value === '') return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return parsed;
}

function listEnv(name, fallback = []) {
  const value = process.env[name];
  if (!value) return fallback;
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function jsonEnv(name, fallback = null) {
  const value = process.env[name];
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new Error(`${name} must be valid JSON: ${error.message}`);
  }
}

const MODEL_VISIBILITIES = new Set(['default', 'restricted', 'admin']);

export function loadConfig() {
  return {
    env: process.env.NODE_ENV || 'development',
    host: process.env.HOST || '127.0.0.1',
    port: intEnv('PORT', 8787),
    authMode: process.env.ROUTER_AUTH_MODE || 'jwt',
    jwt: {
      alg: process.env.ROUTER_JWT_ALG || 'ES256',
      issuer: process.env.ROUTER_JWT_ISSUER || '',
      audience: process.env.ROUTER_JWT_AUDIENCE || 'cli-router',
      publicJwk: jsonEnv('ROUTER_JWT_PUBLIC_JWK'),
      maxAgeSeconds: intEnv('ROUTER_JWT_MAX_AGE_SECONDS', 60),
      clockToleranceSeconds: intEnv('ROUTER_JWT_CLOCK_TOLERANCE_SECONDS', 5)
    },
    providers: {
      claude: boolEnv('ENABLE_CLAUDE', true),
      codex: boolEnv('ENABLE_CODEX', true)
    },
    providerBinaries: {
      claude: process.env.CLAUDE_BIN || 'claude',
      codex: process.env.CODEX_BIN || 'codex'
    },
    modelRegistryPath: process.env.MODEL_REGISTRY_PATH || './config/models.json',
    defaultModel: process.env.DEFAULT_MODEL || 'claude-sonnet-latest',
    runTimeoutMs: intEnv('RUN_TIMEOUT_MS', 150_000),
    maxRequestBytes: intEnv('MAX_REQUEST_BYTES', 30 * 1024 * 1024),
    maxConcurrentRuns: intEnv('MAX_CONCURRENT_RUNS', 2),
    tmpDir: process.env.TMP_DIR || '/tmp/cli-router',
    usage: {
      imageFallbackTokens: intEnv('IMAGE_PROMPT_TOKEN_ESTIMATE', 258),
      imageTileTokens: intEnv('IMAGE_PROMPT_TILE_TOKENS', 258),
      imageSmallMaxPixels: intEnv('IMAGE_PROMPT_SMALL_MAX_PIXELS', 384),
      imageTileSize: intEnv('IMAGE_PROMPT_TILE_SIZE', 768),
      imageMaxTokens: intEnv('IMAGE_PROMPT_MAX_TOKENS', 0)
    },
    attachments: {
      allowedFileUriHosts: listEnv('ALLOWED_FILE_URI_HOSTS', []),
      allowInsecureFileUris: boolEnv('ALLOW_INSECURE_FILE_URIS', false),
      downloadTimeoutMs: intEnv('ATTACHMENT_DOWNLOAD_TIMEOUT_MS', 10_000),
      maxImageBytes: intEnv('MAX_IMAGE_BYTES', 15 * 1024 * 1024),
      maxDocBytes: intEnv('MAX_DOC_BYTES', 10 * 1024 * 1024),
      maxPdfBytes: intEnv('MAX_PDF_BYTES', 10 * 1024 * 1024),
      maxDocTextChars: intEnv('MAX_DOC_TEXT_CHARS', 50_000),
      allowedImageMime: listEnv('ALLOWED_IMAGE_MIME', ['image/png', 'image/jpeg', 'image/webp']),
      allowedDocMime: listEnv('ALLOWED_DOC_MIME', ['application/json', 'text/plain', 'application/pdf'])
    }
  };
}

export async function loadModelRegistry(config) {
  const registryPath = path.resolve(config.modelRegistryPath);
  const raw = await fs.readFile(registryPath, 'utf8');
  const registry = JSON.parse(raw);
  for (const [modelId, entry] of Object.entries(registry)) {
    if (!entry || typeof entry !== 'object') {
      throw new Error(`Invalid model registry entry for ${modelId}`);
    }
    if (!['claude', 'codex'].includes(entry.provider)) {
      throw new Error(`Unsupported provider for ${modelId}: ${entry.provider}`);
    }
    if (!entry.cliModel || typeof entry.cliModel !== 'string') {
      throw new Error(`Missing cliModel for ${modelId}`);
    }
    const visibility = entry.access?.visibility;
    if (!MODEL_VISIBILITIES.has(visibility)) {
      throw new Error(`Invalid or missing access.visibility for ${modelId}`);
    }
  }
  return registry;
}
