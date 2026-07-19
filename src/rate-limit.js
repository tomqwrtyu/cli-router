import { HttpError } from './errors.js';

export class RollingLaunchLimiter {
  constructor({ limit, windowMs = 60_000, now = Date.now }) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.now = now;
    this.launches = new Map();
  }

  consume(userId) {
    const current = this.now();
    const cutoff = current - this.windowMs;
    const recent = (this.launches.get(userId) || []).filter((timestamp) => timestamp > cutoff);
    if (recent.length >= this.limit) {
      const retryAfterMs = Math.max(1, recent[0] + this.windowMs - current);
      this.launches.set(userId, recent);
      throw new HttpError(429, 'RESOURCE_EXHAUSTED', 'Provider launch rate exceeded', {
        reason: 'launch_rate_exceeded',
        limit: this.limit,
        windowMs: this.windowMs,
        retryAfter: Math.ceil(retryAfterMs / 1000)
      });
    }
    recent.push(current);
    this.launches.set(userId, recent);
    return { remaining: this.limit - recent.length };
  }
}
