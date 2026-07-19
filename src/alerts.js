const DEFAULT_TIMEOUT_MS = 5_000;

function safeFields(fields) {
  const safe = {};
  for (const [key, value] of Object.entries(fields || {})) {
    if (value == null || ['string', 'number', 'boolean'].includes(typeof value)) {
      safe[key] = value;
    }
  }
  return safe;
}

export function createAlertSink(config = {}, { fetchImpl = fetch, now = Date.now } = {}) {
  const lastSent = new Map();

  return {
    async emit(event, fields = {}) {
      const payload = {
        version: 1,
        event,
        severity: fields.severity || 'error',
        at: new Date(now()).toISOString(),
        ...safeFields(fields)
      };
      const logFields = Object.entries(payload)
        .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
        .join(' ');
      console.error(`Router operational alert ${logFields}`);

      if (!config.webhookUrl) return;
      const dedupeKey = `${event}:${fields.projectId || ''}:${fields.provider || ''}`;
      const current = now();
      if (lastSent.has(dedupeKey) && current - lastSent.get(dedupeKey) < config.minIntervalMs) return;
      lastSent.set(dedupeKey, current);

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), config.timeoutMs || DEFAULT_TIMEOUT_MS);
      timer.unref?.();
      try {
        const response = await fetchImpl(config.webhookUrl, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(config.webhookSecret
              ? { authorization: `Bearer ${config.webhookSecret}` }
              : {})
          },
          body: JSON.stringify(payload),
          signal: controller.signal
        });
        if (!response.ok) {
          console.error(`Router operational alert delivery failed status=${response.status}`);
        }
      } catch (error) {
        console.error(`Router operational alert delivery failed error_class=${error?.name || 'Error'}`);
      } finally {
        clearTimeout(timer);
      }
    }
  };
}
