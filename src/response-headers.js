export const SECURITY_RESPONSE_HEADERS = Object.freeze({
  'strict-transport-security': 'max-age=31536000',
  'x-content-type-options': 'nosniff'
});

export function withSecurityHeaders(headers = {}) {
  return {
    ...SECURITY_RESPONSE_HEADERS,
    ...headers
  };
}
