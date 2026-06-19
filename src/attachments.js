import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import path from 'node:path';
import pdfParse from 'pdf-parse';
import { HttpError } from './errors.js';

const EXTENSIONS = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'application/json': '.json',
  'text/plain': '.txt',
  'application/pdf': '.pdf'
};

function mimeFromData(data, fallback) {
  return data.mime_type || data.mimeType || fallback || '';
}

function displayNameFromUrl(url) {
  try {
    const parsed = new URL(url);
    const base = path.basename(parsed.pathname);
    return base || 'attachment';
  } catch {
    return 'attachment';
  }
}

function isHostAllowed(hostname, allowedHosts) {
  return allowedHosts.some((entry) => {
    if (entry.startsWith('.')) return hostname === entry.slice(1) || hostname.endsWith(entry);
    return hostname === entry;
  });
}

function assertAllowedUri(uri, config) {
  let parsed;
  try {
    parsed = new URL(uri);
  } catch {
    throw new HttpError(400, 'INVALID_ARGUMENT', 'file_uri must be a valid URL');
  }
  if (parsed.protocol !== 'https:' && !(config.attachments.allowInsecureFileUris && parsed.protocol === 'http:')) {
    throw new HttpError(400, 'INVALID_ARGUMENT', 'file_uri must use https', {
      reason: 'invalid_file_uri_scheme'
    });
  }
  if (!isHostAllowed(parsed.hostname, config.attachments.allowedFileUriHosts)) {
    throw new HttpError(400, 'INVALID_ARGUMENT', 'file_uri host is not allowed', {
      reason: 'file_uri_host_not_allowed',
      host: parsed.hostname
    });
  }
}

function maxBytesForMime(mimeType, config) {
  if (config.attachments.allowedImageMime.includes(mimeType)) return config.attachments.maxImageBytes;
  if (mimeType === 'application/pdf') return config.attachments.maxPdfBytes;
  if (config.attachments.allowedDocMime.includes(mimeType)) return config.attachments.maxDocBytes;
  throw new HttpError(415, 'INVALID_ARGUMENT', 'Unsupported attachment MIME type', {
    reason: 'unsupported_attachment_type',
    mimeType
  });
}

async function readResponseWithLimit(response, maxBytes) {
  const reader = response.body?.getReader();
  if (!reader) {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > maxBytes) throwTooLarge(maxBytes);
    return buffer;
  }

  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throwTooLarge(maxBytes);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

function throwTooLarge(maxBytes) {
  throw new HttpError(413, 'INVALID_ARGUMENT', 'Attachment is too large', {
    reason: 'attachment_too_large',
    maxBytes
  });
}

async function downloadFile(uri, mimeType, config) {
  assertAllowedUri(uri, config);
  const maxBytes = maxBytesForMime(mimeType, config);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.attachments.downloadTimeoutMs);
  try {
    const response = await fetch(uri, { signal: controller.signal });
    if (!response.ok) {
      throw new HttpError(422, 'INVALID_ARGUMENT', 'Attachment fetch failed', {
        reason: 'attachment_fetch_failed',
        status: response.status
      });
    }
    const contentLength = response.headers.get('content-length');
    if (contentLength && Number.parseInt(contentLength, 10) > maxBytes) {
      throwTooLarge(maxBytes);
    }
    return await readResponseWithLimit(response, maxBytes);
  } catch (error) {
    if (error.name === 'AbortError') {
      throw new HttpError(408, 'DEADLINE_EXCEEDED', 'Attachment download timed out', {
        reason: 'attachment_timeout'
      });
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function decodeInlineData(inlineData, mimeType, config) {
  if (typeof inlineData.data !== 'string') {
    throw new HttpError(400, 'INVALID_ARGUMENT', 'inline_data.data must be base64');
  }
  const maxBytes = maxBytesForMime(mimeType, config);
  const buffer = Buffer.from(inlineData.data, 'base64');
  if (buffer.length > maxBytes) throwTooLarge(maxBytes);
  return buffer;
}

async function writeAttachment(runDir, name, mimeType, buffer) {
  const safeName = name.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80) || 'attachment';
  const extension = EXTENSIONS[mimeType] || '';
  const fileName = safeName.endsWith(extension) ? safeName : `${safeName}${extension}`;
  const filePath = path.join(runDir, `${crypto.randomUUID()}-${fileName}`);
  await fs.writeFile(filePath, buffer, { mode: 0o600 });
  return filePath;
}

function truncateText(text, maxChars) {
  if (text.length <= maxChars) return { text, truncated: false };
  return { text: text.slice(0, maxChars), truncated: true };
}

async function textFromBuffer(mimeType, buffer, config) {
  if (mimeType === 'application/pdf') {
    let parsed;
    try {
      parsed = await pdfParse(buffer);
    } catch (error) {
      throw new HttpError(422, 'INVALID_ARGUMENT', `PDF text extraction failed: ${error.message}`, {
        reason: 'pdf_extract_failed'
      });
    }
    return truncateText(parsed.text || '', config.attachments.maxDocTextChars);
  }

  const decoded = buffer.toString('utf8');
  if (mimeType === 'application/json') {
    try {
      JSON.parse(decoded);
    } catch {
      throw new HttpError(422, 'INVALID_ARGUMENT', 'JSON attachment is not valid UTF-8 JSON', {
        reason: 'invalid_json_attachment'
      });
    }
  }
  return truncateText(decoded, config.attachments.maxDocTextChars);
}

export async function materializePart(part, { config, runDir, modelEntry }) {
  const data = part.inlineData || part.fileData;
  const mimeType = mimeFromData(data);
  if (!mimeType) {
    throw new HttpError(400, 'INVALID_ARGUMENT', 'Attachment MIME type is required');
  }

  const isImage = config.attachments.allowedImageMime.includes(mimeType);
  const isDoc = config.attachments.allowedDocMime.includes(mimeType);
  if (!isImage && !isDoc) {
    throw new HttpError(415, 'INVALID_ARGUMENT', 'Unsupported attachment MIME type', {
      reason: 'unsupported_attachment_type',
      mimeType
    });
  }

  const name = part.fileData?.file_uri
    ? displayNameFromUrl(part.fileData.file_uri)
    : `inline-${mimeType.replace('/', '-')}`;

  const buffer = part.fileData
    ? await downloadFile(part.fileData.file_uri, mimeType, config)
    : decodeInlineData(part.inlineData, mimeType, config);

  if (isImage) {
    if (!modelEntry.supportsImages) {
      throw new HttpError(400, 'INVALID_ARGUMENT', 'Selected model does not support image attachments through this router', {
        reason: 'model_does_not_support_images',
        provider: modelEntry.provider
      });
    }
    const filePath = await writeAttachment(runDir, name, mimeType, buffer);
    return { kind: 'image', path: filePath, mimeType, name };
  }

  const extracted = await textFromBuffer(mimeType, buffer, config);
  const textBlock = [
    `<attachment name="${name}" mime_type="${mimeType}" truncated="${extracted.truncated ? 'true' : 'false'}">`,
    extracted.text,
    '</attachment>'
  ].join('\n');
  return { kind: 'text', mimeType, name, textBlock };
}
