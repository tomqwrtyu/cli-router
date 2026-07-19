import { HttpError } from './errors.js';

const QUOTA_REASON = 'provider_quota_exceeded';

function durationMs(text) {
  const match = /(?:try again|resets?|available again)[^\n]*?\bin\s+(?:(\d+)\s*d(?:ays?)?)?\s*(?:(\d+)\s*h(?:ours?|rs?)?)?\s*(?:(\d+)\s*m(?:in(?:utes?)?)?)?/i.exec(text);
  if (!match || !match.slice(1).some(Boolean)) return null;
  const [, days = '0', hours = '0', minutes = '0'] = match;
  return (Number(days) * 24 * 60 + Number(hours) * 60 + Number(minutes)) * 60_000;
}

function utcClockReset(text, nowMs) {
  const match = /resets?\s+(?:at\s+)?(\d{1,2}):(\d{2})\s*(am|pm)?\s*\(?(?:UTC|GMT)\)?/i.exec(text);
  if (!match) return null;
  let hour = Number(match[1]);
  const minute = Number(match[2]);
  const meridiem = match[3]?.toLowerCase();
  if (hour > 23 || minute > 59 || (meridiem && (hour < 1 || hour > 12))) return null;
  if (meridiem === 'am') hour %= 12;
  if (meridiem === 'pm') hour = (hour % 12) + 12;
  const now = new Date(nowMs);
  let resetAt = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hour, minute);
  if (resetAt <= nowMs) resetAt += 24 * 60 * 60_000;
  return resetAt;
}

function explicitReset(text) {
  const epoch = /(?:reset(?:s|_at)?|available_at)["'\s:=]+(\d{10,13})/i.exec(text);
  if (epoch) {
    const value = Number(epoch[1]);
    return epoch[1].length === 10 ? value * 1000 : value;
  }
  const dated = /(?:resets?|available again)(?:\s+at|\s+on)?\s+([^\n.]{8,80}(?:UTC|GMT|Z))/i.exec(text);
  if (!dated) return null;
  const parsed = Date.parse(dated[1]);
  return Number.isFinite(parsed) ? parsed : null;
}

export function parseQuotaResetAt(output, {
  nowMs = Date.now(),
  fallbackMs = 15 * 60_000,
  maxCooldownMs = 7 * 24 * 60 * 60_000
} = {}) {
  if (!Number.isFinite(fallbackMs) || fallbackMs < 1) fallbackMs = 15 * 60_000;
  if (!Number.isFinite(maxCooldownMs) || maxCooldownMs < 1) maxCooldownMs = 7 * 24 * 60 * 60_000;
  const text = String(output || '');
  const relative = durationMs(text);
  const candidates = [
    relative === null ? null : nowMs + relative,
    utcClockReset(text, nowMs),
    explicitReset(text)
  ].filter((value) => Number.isFinite(value) && value > nowMs);
  const parsed = candidates.length > 0 ? Math.min(...candidates) : nowMs + fallbackMs;
  return Math.min(parsed, nowMs + maxCooldownMs);
}

export function quotaErrorDetails(provider, output, config = {}, nowMs = Date.now()) {
  const disabledUntilMs = parseQuotaResetAt(output, {
    nowMs,
    fallbackMs: config.fallbackCooldownMs,
    maxCooldownMs: config.maxCooldownMs
  });
  return {
    reason: QUOTA_REASON,
    provider,
    disabledUntil: new Date(disabledUntilMs).toISOString(),
    retryAfter: Math.max(1, Math.ceil((disabledUntilMs - nowMs) / 1000))
  };
}

export class ProviderHealthCache {
  constructor(config = {}, { now = Date.now, onUnavailable = null } = {}) {
    this.config = config;
    this.now = now;
    this.onUnavailable = onUnavailable;
    this.unavailable = new Map();
  }

  markQuotaError(provider, error) {
    if (error?.details?.reason !== QUOTA_REASON || !provider) return false;
    const current = this.now();
    const parsed = Date.parse(error.details.disabledUntil || '');
    const fallback = current + (this.config.fallbackCooldownMs || 15 * 60_000);
    const max = current + (this.config.maxCooldownMs || 7 * 24 * 60 * 60_000);
    const disabledUntil = Math.min(Number.isFinite(parsed) && parsed > current ? parsed : fallback, max);
    const previous = this.unavailable.get(provider)?.disabledUntil || 0;
    this.unavailable.set(provider, { disabledUntil });
    if (disabledUntil > previous) this.onUnavailable?.({ provider, disabledUntil });
    return true;
  }

  status(provider) {
    const entry = this.unavailable.get(provider);
    if (!entry) return { available: true };
    const current = this.now();
    if (entry.disabledUntil <= current) {
      this.unavailable.delete(provider);
      return { available: true };
    }
    return {
      available: false,
      disabledUntil: new Date(entry.disabledUntil).toISOString(),
      retryAfter: Math.max(1, Math.ceil((entry.disabledUntil - current) / 1000))
    };
  }

  assertAvailable(provider) {
    const status = this.status(provider);
    if (status.available) return;
    throw new HttpError(429, 'RESOURCE_EXHAUSTED', 'Provider quota is temporarily unavailable', {
      reason: QUOTA_REASON,
      provider,
      disabledUntil: status.disabledUntil,
      retryAfter: status.retryAfter
    });
  }
}
