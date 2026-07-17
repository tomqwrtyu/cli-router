import http from 'node:http';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { loadConfig, loadModelRegistry } from './config.js';
import { createJwtVerifier } from './auth.js';
import { buildCallbackEvent, callbackContextFromJwt, createCallbackClient } from './callback.js';
import { createCorsPolicy } from './cors.js';
import { estimateUsageMetadata, geminiDoneChunk, geminiTextChunk, geminiTextResponse, normalizeGeminiRequest } from './gemini.js';
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

async function handleGenerate({
  req,
  res,
  url,
  config,
  registry,
  verifyJwt,
  limiter,
  callbackClient,
  responseHeaders
}) {
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
  const jwtPayload = await verifyJwt(req, url, rawBody);
  const callbackContext = callbackContextFromJwt(jwtPayload, callbackClient.enabled);
  if (callbackContext) {
    responseHeaders['x-router-request-id'] = callbackContext.requestId;
  }
  const modelEntry = registry[modelId];

  let limiterEntered = false;
  let normalized;
  let callbackEvent = null;
  let caughtError = null;
  try {
    assertProviderEnabled(modelId, modelEntry, config);
    limiter.enter();
    limiterEntered = true;
    normalized = await normalizeGeminiRequest(parseJson(rawBody), config, modelEntry);
    if (stream) {
      sendSseHeaders(res, responseHeaders);
      let accumulatedText = '';
      await streamCli(normalized, modelEntry, config, (text) => {
        if (text) {
          accumulatedText += text;
          writeSseData(res, geminiTextChunk(text));
        }
      });
      if (!accumulatedText.trim()) {
        throw new HttpError(502, 'UNAVAILABLE', 'Provider returned an empty response', {
          reason: 'provider_empty_output',
          provider: modelEntry.provider
        });
      }
      const usageMetadata = estimateUsageMetadata(normalized, accumulatedText, config);
      if (callbackContext) {
        usageMetadata.routerRequestId = callbackContext.requestId;
        callbackEvent = buildCallbackEvent({
          context: callbackContext,
          modelId,
          provider: modelEntry.provider,
          usageMetadata
        });
      }
      writeSseData(res, geminiDoneChunk(usageMetadata));
      res.end();
    } else {
      const text = await runCliOnce(normalized, modelEntry, config);
      if (!text.trim()) {
        throw new HttpError(502, 'UNAVAILABLE', 'Provider returned an empty response', {
          reason: 'provider_empty_output',
          provider: modelEntry.provider
        });
      }
      const usageMetadata = estimateUsageMetadata(normalized, text, config);
      if (callbackContext) {
        usageMetadata.routerRequestId = callbackContext.requestId;
        callbackEvent = buildCallbackEvent({
          context: callbackContext,
          modelId,
          provider: modelEntry.provider,
          usageMetadata
        });
      }
      sendJson(res, 200, geminiTextResponse(text, 'STOP', usageMetadata), responseHeaders);
    }
  } catch (error) {
    caughtError = error;
    if (callbackContext) {
      callbackEvent = buildCallbackEvent({
        context: callbackContext,
        modelId,
        provider: modelEntry?.provider || null,
        error
      });
    }
  } finally {
    if (limiterEntered) limiter.leave();
    if (normalized?.runDir) {
      await fs.rm(normalized.runDir, { recursive: true, force: true });
    }
  }

  if (callbackEvent) {
    const delivery = callbackClient.deliver(callbackEvent).catch((error) => {
      console.error(
        `Router callback delivery failed request_id=${callbackContext.requestId} event=${callbackEvent.event}: ${error.message}`
      );
    });
    if (caughtError) void delivery;
    else await delivery;
  }

  if (caughtError) throw caughtError;

  return true;
}

async function handleModels({ req, res, url, config, registry, verifyJwt, responseHeaders }) {
  if (req.method !== 'GET' || url.pathname !== '/v1beta/models') return false;
  const rawBody = Buffer.alloc(0);
  await verifyJwt(req, url, rawBody);
  const models = Object.entries(registry)
    .filter(([, entry]) => entry.enabled !== false && config.providers[entry.provider])
    .map(([name, entry]) => ({
      name: `models/${name}`,
      displayName: name,
      supportedGenerationMethods: ['generateContent', 'streamGenerateContent'],
      provider: entry.provider,
      supportsImages: Boolean(entry.supportsImages),
      access: entry.access,
      billing: entry.billing || null
    }));
  sendJson(res, 200, { models }, responseHeaders);
  return true;
}

function handleHealth(req, res, url, responseHeaders) {
  if (req.method === 'GET' && url.pathname === '/health') {
    sendJson(res, 200, { ok: true }, responseHeaders);
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
  const corsPolicy = createCorsPolicy(config.cors);
  const callbackClient = createCallbackClient(config.callback);

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    let responseHeaders = {};
    try {
      responseHeaders = corsPolicy.headersForRequest(req);
      if (corsPolicy.handlePreflight(req, res, responseHeaders)) return;
      if (handleHealth(req, res, url, responseHeaders)) return;
      if (await handleModels({ req, res, url, config, registry, verifyJwt, responseHeaders })) return;
      if (req.method === 'POST' && await handleGenerate({
        req,
        res,
        url,
        config,
        registry,
        verifyJwt,
        limiter,
        callbackClient,
        responseHeaders
      })) return;
      throw new HttpError(404, 'NOT_FOUND', 'Route not found');
    } catch (error) {
      const { statusCode, body } = geminiError(error);
      if (!res.headersSent) {
        sendJson(res, statusCode, body, responseHeaders);
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
