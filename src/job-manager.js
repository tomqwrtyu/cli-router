import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import { HttpError } from './errors.js';
import { assertPromptWithinModelLimits, estimateTextTokens, estimateUsageMetadata, normalizeGeminiRequest } from './gemini.js';
import { streamCli } from './cli.js';
import { buildJobCallbackEvent } from './callback.js';
import { RollingLaunchLimiter } from './rate-limit.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ACTIONS = new Set([
  'chat',
  'condense_memory',
  'increment_memory',
  'interpret_lot',
  'rectification',
  'initial_analysis',
  'fortune'
]);
const TERMINAL = new Set([
  'completed',
  'cancelled',
  'max_tokens',
  'provider_failed',
  'provider_timeout',
  'failed_partial',
  'launch_rejected',
  'expired'
]);

function publicJob(job) {
  return {
    requestId: job.id,
    status: job.status,
    action: job.action,
    model: job.model,
    startedAt: job.startedAt ? new Date(job.startedAt).toISOString() : null,
    completedAt: job.completedAt ? new Date(job.completedAt).toISOString() : null
  };
}

function validateEnvelope(envelope, claims, projectId) {
  if (!envelope || typeof envelope !== 'object') {
    throw new HttpError(400, 'INVALID_ARGUMENT', 'Launch body must be an object');
  }
  for (const field of ['requestId', 'userId']) {
    if (!UUID_PATTERN.test(envelope[field] || '')) {
      throw new HttpError(400, 'INVALID_ARGUMENT', `Invalid ${field}`, { reason: 'invalid_launch_envelope' });
    }
  }
  if (!ACTIONS.has(envelope.action)) {
    throw new HttpError(400, 'INVALID_ARGUMENT', 'Unsupported job action', { reason: 'invalid_job_action' });
  }
  if (typeof envelope.model !== 'string' || !envelope.model) {
    throw new HttpError(400, 'INVALID_ARGUMENT', 'Invalid job model', { reason: 'invalid_job_model' });
  }
  if (!/^[0-9a-f]{64}$/.test(envelope.payloadHash || '')) {
    throw new HttpError(400, 'INVALID_ARGUMENT', 'Invalid payload hash', { reason: 'invalid_payload_hash' });
  }
  if (envelope.projectId !== projectId) {
    throw new HttpError(403, 'PERMISSION_DENIED', 'Project does not match Router configuration', {
      reason: 'project_mismatch'
    });
  }
  const claimPairs = [
    ['request_id', 'requestId'],
    ['user_id', 'userId'],
    ['action', 'action'],
    ['model', 'model'],
    ['project_id', 'projectId'],
    ['payload_hash', 'payloadHash']
  ];
  for (const [claim, field] of claimPairs) {
    if (claims[claim] !== envelope[field]) {
      throw new HttpError(401, 'UNAUTHENTICATED', `JWT ${claim} does not match launch body`, {
        reason: 'launch_claim_mismatch'
      });
    }
  }
}

function fitWithinTokenLimit(existing, chunk, maxTokens) {
  if (estimateTextTokens(existing + chunk) <= maxTokens) return { text: chunk, limited: false };
  let low = 0;
  let high = chunk.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (estimateTextTokens(existing + chunk.slice(0, middle)) <= maxTokens) low = middle;
    else high = middle - 1;
  }
  return { text: chunk.slice(0, low), limited: true };
}

export class JobManager {
  constructor({ config, registry, claimClient, streamTokens, callbackClient, outbox, providerHealth = null, alerts = null, now = Date.now }) {
    this.config = config;
    this.registry = registry;
    this.claimClient = claimClient;
    this.streamTokens = streamTokens;
    this.callbackClient = callbackClient;
    this.outbox = outbox;
    this.providerHealth = providerHealth;
    this.alerts = alerts;
    this.now = now;
    this.jobs = new Map();
    this.activeByUser = new Map();
    this.cancelledAt = new Map();
    this.clientLaunchEvents = new Map();
    this.usedStreamTokens = new Set();
    this.launchLimiter = new RollingLaunchLimiter({
      limit: config.backgroundJobs.launchesPerMinute,
      now
    });
    this.outboxTimer = setInterval(
      () => void this.flushOutbox().catch((error) => {
        console.error(`Router callback outbox flush failed error_class=${error?.name || 'Error'}`);
        void this.alerts?.emit('callback_outbox_flush_failed', {
          projectId: this.config.backgroundJobs.projectId,
          errorClass: error?.name || 'Error'
        });
      }),
      config.backgroundJobs.outbox.retryIntervalMs
    );
    this.outboxTimer.unref();
  }

  async launch(envelope, claims) {
    validateEnvelope(envelope, claims, this.config.backgroundJobs.projectId);
    const existing = this.jobs.get(envelope.requestId);
    if (existing) {
      if (
        existing.userId !== envelope.userId ||
        existing.clientId !== (claims.routerClient?.clientId || 'legacy')
      ) {
        throw new HttpError(409, 'ALREADY_EXISTS', 'Request ID belongs to another user');
      }
      const streamToken = await this.streamTokens.issue({
        requestId: existing.id,
        userId: existing.userId,
        projectId: existing.projectId
      });
      return {
        accepted: true,
        duplicate: true,
        request: publicJob(existing),
        streamToken
      };
    }
    const modelEntry = this.registry[envelope.model];
    if (!modelEntry || modelEntry.enabled === false || !this.config.providers[modelEntry.provider]) {
      throw new HttpError(503, 'UNAVAILABLE', 'Requested Router model is unavailable', {
        reason: 'model_unavailable'
      });
    }
    this.providerHealth?.assertAvailable(modelEntry.provider);
    const active = this.activeByUser.get(envelope.userId) || 0;
    const clientMaxActive = claims.routerClient?.quota?.maxActivePerUser ||
      this.config.backgroundJobs.maxActivePerUser;
    const maxActive = Math.min(this.config.backgroundJobs.maxActivePerUser, clientMaxActive);
    if (active >= maxActive) {
      throw new HttpError(429, 'RESOURCE_EXHAUSTED', 'User already has an active generation', {
        reason: 'user_concurrency_exceeded',
        retryAfter: 3
      });
    }
    const cancelledAt = this.cancelledAt.get(envelope.userId) || 0;
    const cooldownRemaining = cancelledAt + this.config.backgroundJobs.cancelCooldownMs - this.now();
    if (cooldownRemaining > 0) {
      throw new HttpError(429, 'RESOURCE_EXHAUSTED', 'Generation cancellation cooldown is active', {
        reason: 'cancel_cooldown',
        retryAfter: Math.ceil(cooldownRemaining / 1000)
      });
    }
    this.consumeClientLaunch(claims, envelope.userId);

    const streamToken = await this.streamTokens.issue({
      requestId: envelope.requestId,
      userId: envelope.userId,
      projectId: envelope.projectId
    });
    const job = {
      id: envelope.requestId,
      clientId: claims.routerClient?.clientId || 'legacy',
      projectId: envelope.projectId,
      userId: envelope.userId,
      sessionId: envelope.sessionId || null,
      chartId: envelope.chartId || null,
      messageId: envelope.messageId || null,
      action: envelope.action,
      model: envelope.model,
      provider: modelEntry.provider,
      payloadHash: envelope.payloadHash,
      status: 'launching',
      output: '',
      subscribers: new Set(),
      controller: new AbortController(),
      createdAt: this.now(),
      startedAt: null,
      completedAt: null,
      webSearchEnabled: false,
      usageMetadata: null
    };
    job.streamJtis = new Set();
    this.jobs.set(job.id, job);
    this.activeByUser.set(job.userId, active + 1);
    queueMicrotask(() => void this.run(job, modelEntry));
    return { accepted: true, duplicate: false, request: publicJob(job), streamToken };
  }

  consumeClientLaunch(claims, userId) {
    const client = claims.routerClient;
    if (!client) return;
    const limit = Math.min(
      this.config.backgroundJobs.launchesPerMinute,
      client.quota?.launchesPerMinute || this.config.backgroundJobs.launchesPerMinute
    );
    const key = `${client.clientId}:${userId}`;
    const cutoff = this.now() - 60_000;
    const recent = (this.clientLaunchEvents.get(key) || []).filter((timestamp) => timestamp > cutoff);
    if (recent.length >= limit) {
      const retryAfter = Math.max(1, Math.ceil((recent[0] + 60_000 - this.now()) / 1000));
      throw new HttpError(429, 'RESOURCE_EXHAUSTED', 'Trusted client launch quota exceeded', {
        reason: 'client_launch_rate_exceeded',
        retryAfter
      });
    }
    recent.push(this.now());
    this.clientLaunchEvents.set(key, recent);
  }

  async authorizeStream(requestId, token) {
    const payload = await this.streamTokens.verify(
      token,
      requestId,
      this.config.backgroundJobs.projectId
    );
    if (this.usedStreamTokens.has(payload.jti)) {
      throw new HttpError(401, 'UNAUTHENTICATED', 'Stream token was already used', {
        reason: 'stream_token_replayed'
      });
    }
    const job = this.jobs.get(requestId);
    if (!job || job.userId !== payload.user_id) {
      throw new HttpError(404, 'NOT_FOUND', 'Generation request not found');
    }
    this.usedStreamTokens.add(payload.jti);
    job.streamJtis.add(payload.jti);
    return job;
  }

  async issueStreamToken(requestId, claims) {
    const job = this.jobs.get(requestId);
    if (!job) throw new HttpError(404, 'NOT_FOUND', 'Generation request not found');
    if (
      claims.request_id !== requestId ||
      claims.user_id !== job.userId ||
      claims.project_id !== job.projectId ||
      (claims.routerClient?.clientId || 'legacy') !== job.clientId
    ) {
      throw new HttpError(403, 'PERMISSION_DENIED', 'Request identity mismatch');
    }
    return this.streamTokens.issue({
      requestId: job.id,
      userId: job.userId,
      projectId: job.projectId
    });
  }

  subscribe(job, subscriber) {
    job.subscribers.add(subscriber);
    subscriber({ type: 'snapshot', requestId: job.id, status: job.status, text: job.output });
    if (TERMINAL.has(job.status)) {
      subscriber({ type: 'terminal', requestId: job.id, status: job.status });
      subscriber(null);
      return () => {};
    }
    return () => job.subscribers.delete(subscriber);
  }

  status(requestId, claims) {
    const job = this.jobs.get(requestId);
    if (!job) throw new HttpError(404, 'NOT_FOUND', 'Generation request not found');
    if (
      claims.request_id !== requestId ||
      claims.user_id !== job.userId ||
      (claims.routerClient?.clientId || 'legacy') !== job.clientId
    ) {
      throw new HttpError(403, 'PERMISSION_DENIED', 'Request identity mismatch');
    }
    return publicJob(job);
  }

  cancel(requestId, claims) {
    const job = this.jobs.get(requestId);
    if (!job) throw new HttpError(404, 'NOT_FOUND', 'Generation request not found');
    if (
      claims.request_id !== requestId ||
      claims.user_id !== job.userId ||
      (claims.routerClient?.clientId || 'legacy') !== job.clientId
    ) {
      throw new HttpError(403, 'PERMISSION_DENIED', 'Request identity mismatch');
    }
    if (TERMINAL.has(job.status)) return publicJob(job);
    job.cancelRequested = true;
    job.controller.abort('cancelled');
    this.cancelledAt.set(job.userId, this.now());
    return publicJob(job);
  }

  publish(job, event) {
    for (const subscriber of job.subscribers) {
      try {
        subscriber(event);
      } catch {
        job.subscribers.delete(subscriber);
      }
    }
  }

  async run(job, modelEntry) {
    let normalized;
    let heartbeatTimer;
    let terminalError = null;
    try {
      const claimed = await this.claimClient.claim({
        projectId: job.projectId,
        requestId: job.id,
        userId: job.userId,
        action: job.action,
        model: job.model,
        payloadHash: job.payloadHash
      });
      for (const field of ['requestId', 'userId', 'action', 'model']) {
        if (claimed[field] !== job[field === 'requestId' ? 'id' : field]) {
          throw new HttpError(409, 'UNAVAILABLE', 'Claim payload identity mismatch', {
            reason: 'claim_identity_mismatch'
          });
        }
      }
      if (typeof claimed.bodyJson !== 'string') {
        throw new HttpError(409, 'UNAVAILABLE', 'Claim payload must contain bodyJson', {
          reason: 'invalid_claim_response'
        });
      }
      const claimedHash = crypto.createHash('sha256').update(claimed.bodyJson).digest('hex');
      if (claimedHash !== job.payloadHash) {
        throw new HttpError(409, 'UNAVAILABLE', 'Claim payload hash does not match launch', {
          reason: 'claim_payload_hash_mismatch'
        });
      }
      const requestBody = JSON.parse(claimed.bodyJson);
      normalized = await normalizeGeminiRequest(requestBody, this.config, modelEntry);
      job.webSearchEnabled = claimed.webSearchEnabled !== false;
      normalized.webSearchEnabled = job.webSearchEnabled;
      assertPromptWithinModelLimits(normalized, modelEntry, this.config);
      if (job.controller.signal.aborted) {
        throw new HttpError(499, 'CANCELLED', 'Generation was cancelled before provider launch', {
          reason: 'provider_cancelled',
          provider: modelEntry.provider
        });
      }
      this.launchLimiter.consume(job.userId);
      job.status = 'running';
      job.startedAt = this.now();
      this.publish(job, { type: 'status', requestId: job.id, status: job.status });
      heartbeatTimer = setInterval(() => {
        this.publish(job, { type: 'heartbeat', requestId: job.id, at: new Date().toISOString() });
        void this.sendHeartbeat(job);
      }, this.config.backgroundJobs.heartbeatMs);
      heartbeatTimer.unref();

      const claimedMax = Number.isInteger(claimed.maxOutputTokens) && claimed.maxOutputTokens > 0
        ? claimed.maxOutputTokens
        : this.config.backgroundJobs.maxOutputTokens;
      const maxOutputTokens = Math.min(this.config.backgroundJobs.maxOutputTokens, claimedMax);
      const result = await streamCli(normalized, modelEntry, this.config, (text) => {
        if (!text || job.controller.signal.aborted) return;
        const fitted = fitWithinTokenLimit(job.output, text, maxOutputTokens);
        if (fitted.text) {
          job.output += fitted.text;
          this.publish(job, { type: 'text_delta', requestId: job.id, text: fitted.text });
        }
        if (fitted.limited) job.controller.abort('max_tokens');
      }, {
        signal: job.controller.signal,
        onEvent: (event) => this.publish(job, { ...event, requestId: job.id })
      });
      if (!job.output.trim()) {
        throw new HttpError(502, 'UNAVAILABLE', 'Provider returned an empty response', {
          reason: 'provider_empty_output',
          provider: modelEntry.provider
        });
      }
      job.usageMetadata = result.usageMetadata || estimateUsageMetadata(normalized, job.output, this.config);
      job.usageMetadata.usageSource = result.usageMetadata ? 'provider' : 'estimated';
      job.status = 'completed';
    } catch (error) {
      terminalError = error;
      this.providerHealth?.markQuotaError(modelEntry.provider, error);
      const reason = error?.details?.reason;
      if (reason === 'output_limit_reached') {
        job.status = 'max_tokens';
      } else if (reason === 'provider_cancelled' && job.cancelRequested) {
        job.status = 'cancelled';
      } else if (reason === 'provider_timeout') {
        job.status = 'provider_timeout';
      } else if (reason === 'launch_rate_exceeded' || reason === 'claim_rejected') {
        job.status = 'launch_rejected';
      } else {
        job.status = job.output ? 'failed_partial' : 'provider_failed';
      }
      if (normalized && (job.status === 'cancelled' || job.status === 'max_tokens')) {
        job.usageMetadata = estimateUsageMetadata(normalized, job.output, this.config);
        job.usageMetadata.usageSource = job.status === 'cancelled' ? 'cancel_estimate' : 'estimated';
      }
    } finally {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      if (normalized?.runDir) await fs.rm(normalized.runDir, { recursive: true, force: true });
      job.completedAt = this.now();
      this.activeByUser.set(job.userId, Math.max(0, (this.activeByUser.get(job.userId) || 1) - 1));
      const callbackEvent = buildJobCallbackEvent({
        job,
        usageMetadata: job.usageMetadata,
        error: terminalError
      });
      try {
        await this.callbackClient.deliver(callbackEvent);
      } catch (error) {
        try {
          this.outbox.enqueue(callbackEvent);
          console.error(
            `Router callback queued request_id=${job.id} status=${job.status} error_class=${error?.name || 'Error'}`
          );
        } catch (outboxError) {
          console.error(
            `Router callback outbox enqueue failed request_id=${job.id} error_class=${outboxError?.name || 'Error'}`
          );
          void this.alerts?.emit('callback_outbox_enqueue_failed', {
            projectId: job.projectId,
            requestId: job.id,
            errorClass: outboxError?.name || 'Error'
          });
        }
      }
      this.publish(job, { type: 'terminal', requestId: job.id, status: job.status });
      for (const subscriber of job.subscribers) subscriber(null);
      job.subscribers.clear();
      const cleanup = setTimeout(() => {
        this.jobs.delete(job.id);
        for (const jti of job.streamJtis) this.usedStreamTokens.delete(jti);
      }, this.config.backgroundJobs.terminalRetentionMs);
      cleanup.unref();
    }
  }

  async sendHeartbeat(job) {
    try {
      await this.callbackClient.deliver({
        version: 2,
        event: 'router.generation.heartbeat',
        projectId: job.projectId,
        requestId: job.id,
        userId: job.userId,
        status: job.status,
        at: new Date().toISOString()
      });
    } catch {
      // Heartbeats are advisory and are never queued behind terminal callbacks.
    }
  }

  async flushOutbox() {
    const expired = this.outbox.purgeExpired();
    if (expired > 0) {
      console.error(`Router callback outbox entries expired count=${expired}`);
      void this.alerts?.emit('callback_outbox_entries_expired', {
        projectId: this.config.backgroundJobs.projectId,
        count: expired
      });
    }
    for (const item of this.outbox.due()) {
      try {
        await this.callbackClient.deliver(item.event);
        this.outbox.delivered(item.id);
      } catch (error) {
        this.outbox.failed(item.id, item.attempts, error);
      }
    }
  }

  close() {
    clearInterval(this.outboxTimer);
    this.outbox.close();
  }
}
