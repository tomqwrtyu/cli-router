import http from 'node:http';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { loadConfig, loadModelRegistry } from './config.js';
import { clientAllowsModel, createJwtVerifier } from './auth.js';
import { buildCallbackEvent, callbackContextFromJwt, createCallbackClient } from './callback.js';
import { createClaimClient } from './claim.js';
import { createCorsPolicy } from './cors.js';
import { assertPromptWithinModelLimits, estimateUsageMetadata, geminiDoneChunk, geminiTextChunk, geminiTextResponse, normalizeGeminiRequest } from './gemini.js';
import { geminiError } from './errors.js';
import { readRequestBody, sendJson, sendSseHeaders, writeSseData, writeSseEvent } from './http.js';
import { HttpError } from './errors.js';
import { runCliOnce, streamCli } from './cli.js';
import { JobManager } from './job-manager.js';
import { createEncryptedOutbox } from './outbox.js';
import { createStreamTokenService } from './stream-token.js';
import { ProviderHealthCache } from './provider-health.js';
import { createAlertSink } from './alerts.js';

const routePattern = /^\/v1beta\/models\/([^/]+):(generateContent|streamGenerateContent)$/;

function assertProviderEnabled(modelId, modelEntry, config, providerHealth = null, claims = null) {
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
  if (!clientAllowsModel(claims, modelId)) {
    throw new HttpError(403, 'PERMISSION_DENIED', 'Model is not allowed for this client', {
      reason: 'client_model_denied'
    });
  }
  providerHealth?.assertAvailable(modelEntry.provider);
}

function parseJson(buffer) {
  try {
    return JSON.parse(buffer.toString('utf8'));
  } catch {
    throw new HttpError(400, 'INVALID_ARGUMENT', 'Request body must be valid JSON');
  }
}

function bearerToken(req) {
  const match = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '');
  if (!match) throw new HttpError(401, 'UNAUTHENTICATED', 'Missing bearer token');
  return match[1];
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
  responseHeaders,
  providerHealth
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
  const startedAt = Date.now();

  let limiterEntered = false;
  let normalized;
  let callbackEvent = null;
  let caughtError = null;
  try {
    assertProviderEnabled(modelId, modelEntry, config, providerHealth, jwtPayload);
    limiter.enter();
    limiterEntered = true;
    normalized = await normalizeGeminiRequest(parseJson(rawBody), config, modelEntry);
    assertPromptWithinModelLimits(normalized, modelEntry, config);
    const runConfig = callbackContext
      ? { ...config, runTimeoutMs: config.memoryRunTimeoutMs }
      : config;
    if (stream) {
      sendSseHeaders(res, responseHeaders);
      let accumulatedText = '';
      const keepAlive = setInterval(() => {
        if (!res.writableEnded && !res.destroyed) res.write(': keep-alive\n\n');
      }, 15_000);
      keepAlive.unref();
      try {
        await streamCli(normalized, modelEntry, runConfig, (text) => {
          if (text) {
            accumulatedText += text;
            writeSseData(res, geminiTextChunk(text));
          }
        });
      } finally {
        clearInterval(keepAlive);
      }
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
      const text = await runCliOnce(normalized, modelEntry, runConfig);
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
    providerHealth?.markQuotaError(modelEntry?.provider, error);
    console.error(
      `Generation failed model=${modelId} action=${action} duration_ms=${Date.now() - startedAt} reason=${error?.details?.reason || error?.name || 'unknown'}`
    );
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

export function buildModelCatalog(config, registry, providerHealth = null, claims = null) {
  return (config.backgroundJobs.enabled ? Object.entries(registry) : [])
    .filter(([modelId, entry]) => entry.enabled !== false && config.providers[entry.provider] &&
      clientAllowsModel(claims, modelId) &&
      (providerHealth?.status(entry.provider).available ?? true))
    .map(([name, entry]) => ({
      name: `models/${name}`,
      displayName: name,
      supportedGenerationMethods: ['generateContent', 'streamGenerateContent'],
      provider: entry.provider,
      supportsImages: Boolean(entry.supportsImages),
      access: entry.access,
      billing: entry.billing || null,
      contextWindow: entry.contextWindow || null,
      inputCharLimit: entry.inputCharLimit || null,
      inputTokenLimit: entry.inputTokenLimit || null,
      outputTokenLimit: entry.outputTokenLimit || null,
      capabilities: {
        backgroundJobs: config.backgroundJobs.enabled,
        liveWebSearch: entry.provider === 'codex' && config.codexLiveSearch
      }
    }));
}

async function handleModels({ req, res, url, config, registry, verifyJwt, responseHeaders, providerHealth }) {
  if (req.method !== 'GET' || url.pathname !== '/v1beta/models') return false;
  const rawBody = Buffer.alloc(0);
  const claims = await verifyJwt(req, url, rawBody);
  const models = buildModelCatalog(config, registry, providerHealth, claims);
  sendJson(res, 200, { models }, responseHeaders);
  return true;
}

async function handleJobs({ req, res, url, config, verifyJwt, jobManager, responseHeaders }) {
  if (!url.pathname.startsWith('/v1/jobs')) return false;
  if (!config.backgroundJobs.enabled || !jobManager) {
    throw new HttpError(503, 'UNAVAILABLE', 'Background Router jobs are disabled', {
      reason: 'background_jobs_disabled'
    });
  }

  if (req.method === 'POST' && url.pathname === '/v1/jobs') {
    const rawBody = await readRequestBody(req, 64 * 1024);
    const claims = await verifyJwt(req, url, rawBody);
    const envelope = parseJson(rawBody);
    if (!clientAllowsModel(claims, envelope.model)) {
      throw new HttpError(403, 'PERMISSION_DENIED', 'Model is not allowed for this client', {
        reason: 'client_model_denied'
      });
    }
    const result = await jobManager.launch(envelope, claims);
    sendJson(res, 202, result, responseHeaders);
    return true;
  }

  const streamMatch = /^\/v1\/jobs\/([0-9a-f-]+)\/stream$/i.exec(url.pathname);
  if (req.method === 'GET' && streamMatch) {
    const job = await jobManager.authorizeStream(streamMatch[1], bearerToken(req));
    sendSseHeaders(res, responseHeaders);
    let unsubscribe = () => {};
    const close = () => {
      unsubscribe();
      if (!res.writableEnded) res.end();
    };
    unsubscribe = jobManager.subscribe(job, (event) => {
      if (event === null) {
        close();
        return;
      }
      if (!res.destroyed && !res.writableEnded) writeSseEvent(res, event);
    });
    req.on('close', unsubscribe);
    return true;
  }

  const streamTokenMatch = /^\/v1\/jobs\/([0-9a-f-]+)\/stream-token$/i.exec(url.pathname);
  if (req.method === 'POST' && streamTokenMatch) {
    const rawBody = await readRequestBody(req, 1024);
    const claims = await verifyJwt(req, url, rawBody);
    const streamToken = await jobManager.issueStreamToken(streamTokenMatch[1], claims);
    sendJson(res, 200, { streamToken }, responseHeaders);
    return true;
  }

  const jobMatch = /^\/v1\/jobs\/([0-9a-f-]+)(?:\/(cancel))?$/i.exec(url.pathname);
  if (jobMatch && req.method === 'GET' && !jobMatch[2]) {
    const rawBody = Buffer.alloc(0);
    const claims = await verifyJwt(req, url, rawBody);
    sendJson(res, 200, { request: jobManager.status(jobMatch[1], claims) }, responseHeaders);
    return true;
  }
  if (jobMatch && req.method === 'POST' && jobMatch[2] === 'cancel') {
    const rawBody = await readRequestBody(req, 1024);
    const claims = await verifyJwt(req, url, rawBody);
    sendJson(res, 202, { request: jobManager.cancel(jobMatch[1], claims) }, responseHeaders);
    return true;
  }

  throw new HttpError(404, 'NOT_FOUND', 'Job route not found');
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
  const alerts = createAlertSink(config.alerts);
  const providerHealth = new ProviderHealthCache(config.providerHealth, {
    onUnavailable: ({ provider, disabledUntil }) => {
      console.error(`Provider quota unavailable provider=${provider} disabled_until=${new Date(disabledUntil).toISOString()}`);
      void alerts.emit('provider_quota_unavailable', {
        provider,
        disabledUntil: new Date(disabledUntil).toISOString()
      });
    }
  });
  const verifyJwt = await createJwtVerifier(config);
  const limiter = new RunLimiter(config.maxConcurrentRuns);
  const corsPolicy = createCorsPolicy(config.cors);
  const callbackClient = createCallbackClient(config.callback);
  let jobManager = null;
  if (config.backgroundJobs.enabled) {
    const claimClient = createClaimClient(config.backgroundJobs.claim);
    const streamTokens = createStreamTokenService(config.backgroundJobs.streamToken);
    const outbox = createEncryptedOutbox(
      config.backgroundJobs.outbox,
      config.backgroundJobs.projectId
    );
    jobManager = new JobManager({
      config,
      registry,
      claimClient,
      streamTokens,
      callbackClient,
      outbox,
      providerHealth,
      alerts
    });
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    let responseHeaders = {};
    try {
      responseHeaders = corsPolicy.headersForRequest(req);
      if (corsPolicy.handlePreflight(req, res, responseHeaders)) return;
      if (handleHealth(req, res, url, responseHeaders)) return;
      if (await handleJobs({
        req,
        res,
        url,
        config,
        verifyJwt,
        jobManager,
        providerHealth,
        responseHeaders
      })) return;
      if (await handleModels({ req, res, url, config, registry, verifyJwt, responseHeaders, providerHealth })) return;
      if (req.method === 'POST' && await handleGenerate({
        req,
        res,
        url,
        config,
        registry,
        verifyJwt,
        limiter,
        callbackClient,
        providerHealth,
        responseHeaders
      })) return;
      throw new HttpError(404, 'NOT_FOUND', 'Route not found');
    } catch (error) {
      const { statusCode, body } = geminiError(error);
      if (error?.details?.retryAfter) {
        responseHeaders['retry-after'] = String(error.details.retryAfter);
      }
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
  const shutdown = () => {
    jobManager?.close();
    server.close();
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
