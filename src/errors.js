export class HttpError extends Error {
  constructor(statusCode, status, message, details = {}) {
    super(message);
    this.name = 'HttpError';
    this.statusCode = statusCode;
    this.status = status;
    this.details = details;
  }
}

export function geminiError(error) {
  const statusCode = error instanceof HttpError ? error.statusCode : 500;
  const status = error instanceof HttpError ? error.status : 'INTERNAL';
  const message = error instanceof Error ? error.message : 'Unknown error';
  const details = error instanceof HttpError ? [error.details] : [];
  return {
    statusCode,
    body: {
      error: {
        code: statusCode,
        message,
        status,
        details
      }
    }
  };
}
