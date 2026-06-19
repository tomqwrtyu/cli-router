import http from 'node:http';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { loadConfig, loadModelRegistry } from './config.js';
import { createJwtVerifier } from './auth.js';
import { geminiDoneChunk, geminiTextChunk, geminiTextResponse, normalizeGeminiRequest } from './gemini.js';
import { geminiError } from './errors.js';
import { readRequestBody, sendJson, sendSseHeaders, writeSseData } from './http.js';
import { HttpError } from './errors.js';
import { runCliOnce, streamCli } from './cli.js';

const routePattern = /^\/v1beta\/models\/([^/]+):(generateContent|streamGenerateContent)$/;

function assertProviderEnabled(modelId, modelEntry, config) {
  if (!modelEntry || modelEntry.enabled === false) {
    throw new HttpError(404, 'NOT_FOUND', `Model not found: ${modelId}`, {
      reason: 'model_not_found'
    });
  }
  if (!config.providers[modelEntry.provider]) {
    throw new HttpError(403, 'PERMISSION_DENIED', `Provider is disabled: ${modelEntry.provider}`, {
      reason: 'provider_disabled',
      provider: modelEntry.provider
    });
  }
}

function parseJson(buffer) {
  try {
    return JSON.parse(buffer.toString('utf8'));
  } catch {
    throw new HttpError(400, 'INVALID_ARGUMENT', 'Request body must be valid JSON');
  }
}

class RunLimiter {
  constructor(maxConcurrent) {
    this.maxConcurrent = maxConcurrent;
    this.active = 0;
  }

  enter() {
    if (this.active >= this.maxConcurrent) {
      throw new HttpError(429, 'RESOURCE_EXHAUSTED', 'Too many concurrent runs', {
        reason: 'too_many_concurrent_runs',
        maxConcurrent: this.maxConcurrent
      });
    }
    this.active += 1;
  }

  leave() {
    this.active = Math.max(0, this.active - 1);
  }
}

async function handleGenerate({ req, res, url, config, registry, verifyJwt, limiter }) {
  const match = routePattern.exec(url.pathname);
  if (!match) return false;

  const [, modelId, action] = match;
  const stream = action === 'streamGenerateContent';
  if (stream && url.searchParams.get('alt') !== 'sse') {
    throw new HttpError(400, 'INVALID_ARGUMENT', 'streamGenerateContent requires alt=sse', {
      reason: 'missing_alt_sse'
    });
  }

  const rawBody = await readRequestBody(req, config.maxRequestBytes);
  await verifyJwt(req, url, rawBody);
  const modelEntry = registry[modelId];
  assertProviderEnabled(modelId, modelEntry, config);

  limiter.enter();
  let normalized;
  try {
    normalized = await normalizeGeminiRequest(parseJson(rawBody), config, modelEntry);
    if (stream) {
      sendSseHeaders(res);
      await streamCli(normalized, modelEntry, config, (text) => {
        if (text) writeSseData(res, geminiTextChunk(text));
      });
      writeSseData(res, geminiDoneChunk());
      res.end();
    } else {
      const text = await runCliOnce(normalized, modelEntry, config);
      sendJson(res, 200, geminiTextResponse(text));
    }
  } finally {
    limiter.leave();
    if (normalized?.runDir) {
      await fs.rm(normalized.runDir, { recursive: true, force: true });
    }
  }

  return true;
}

async function handleModels({ req, res, url, config, registry, verifyJwt }) {
  if (req.method !== 'GET' || url.pathname !== '/v1beta/models') return false;
  const rawBody = Buffer.alloc(0);
  await verifyJwt(req, url, rawBody);
  const models = Object.entries(registry)
    .filter(([, entry]) => entry.enabled !== false && config.providers[entry.provider])
    .map(([name, entry]) => ({
      name: `models/${name}`,
      displayName: name,
      supportedGenerationMethods: ['generateContent', 'streamGenerateContent'],
      provider: entry.provider
    }));
  sendJson(res, 200, { models });
  return true;
}

function handleHealth(req, res, url) {
  if (req.method === 'GET' && url.pathname === '/health') {
    sendJson(res, 200, { ok: true });
    return true;
  }
  return false;
}

export async function main() {
  const config = loadConfig();
  await fs.mkdir(config.tmpDir, { recursive: true });
  const registry = await loadModelRegistry(config);
  const verifyJwt = await createJwtVerifier(config);
  const limiter = new RunLimiter(config.maxConcurrentRuns);

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    try {
      if (handleHealth(req, res, url)) return;
      if (await handleModels({ req, res, url, config, registry, verifyJwt })) return;
      if (req.method === 'POST' && await handleGenerate({ req, res, url, config, registry, verifyJwt, limiter })) return;
      throw new HttpError(404, 'NOT_FOUND', 'Route not found');
    } catch (error) {
      const { statusCode, body } = geminiError(error);
      if (!res.headersSent) {
        sendJson(res, statusCode, body);
      } else {
        writeSseData(res, body);
        res.end();
      }
    }
  });

  server.listen(config.port, config.host, () => {
    console.log(`cli-router listening on http://${config.host}:${config.port}`);
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
