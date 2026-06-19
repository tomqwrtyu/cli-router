import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { HttpError } from './errors.js';
import { materializePart } from './attachments.js';

function normalizePartKeys(part) {
  return {
    text: part.text,
    inlineData: part.inline_data || part.inlineData,
    fileData: part.file_data || part.fileData
  };
}

function collectTextParts(content) {
  if (!content) return '';
  const parts = Array.isArray(content.parts) ? content.parts : [];
  return parts
    .map((part) => normalizePartKeys(part).text)
    .filter((text) => typeof text === 'string' && text.length > 0)
    .join('\n');
}

function roleLabel(role) {
  if (role === 'model') return 'Assistant';
  return 'User';
}

export function geminiTextResponse(text, finishReason = 'STOP') {
  return {
    candidates: [
      {
        content: {
          role: 'model',
          parts: [{ text }]
        },
        finishReason
      }
    ]
  };
}

export function geminiTextChunk(text) {
  return {
    candidates: [
      {
        content: {
          role: 'model',
          parts: [{ text }]
        }
      }
    ]
  };
}

export function geminiDoneChunk() {
  return {
    candidates: [
      {
        content: {
          role: 'model',
          parts: []
        },
        finishReason: 'STOP'
      }
    ]
  };
}

export async function normalizeGeminiRequest(body, config, modelEntry) {
  if (!body || typeof body !== 'object') {
    throw new HttpError(400, 'INVALID_ARGUMENT', 'Request body must be a JSON object');
  }
  if (body.tools || body.toolConfig || body.cachedContent) {
    throw new HttpError(400, 'INVALID_ARGUMENT', 'tools, toolConfig, and cachedContent are not supported', {
      reason: 'unsupported_feature'
    });
  }

  const contents = Array.isArray(body.contents) ? body.contents : null;
  if (!contents || contents.length === 0) {
    throw new HttpError(400, 'INVALID_ARGUMENT', 'contents must be a non-empty array');
  }

  const runId = crypto.randomUUID();
  const runDir = await fs.mkdtemp(path.join(config.tmpDir || os.tmpdir(), `${runId}-`));
  const systemInstruction = collectTextParts(body.systemInstruction);
  const contextBlocks = [];
  const imagePaths = [];

  try {
    for (const content of contents) {
      const role = roleLabel(content.role);
      const parts = Array.isArray(content.parts) ? content.parts : [];
      if (parts.length === 0) continue;

      const roleBlocks = [];
      for (const part of parts) {
        const normalized = normalizePartKeys(part);
        if (typeof normalized.text === 'string') {
          roleBlocks.push(normalized.text);
          continue;
        }
        if (normalized.inlineData || normalized.fileData) {
          const materialized = await materializePart(normalized, {
            config,
            runDir,
            modelEntry
          });
          if (materialized.kind === 'image') {
            imagePaths.push(materialized.path);
            roleBlocks.push(`[Attached image: ${materialized.name} (${materialized.mimeType})]`);
          } else if (materialized.kind === 'text') {
            roleBlocks.push(materialized.textBlock);
          }
          continue;
        }
        throw new HttpError(400, 'INVALID_ARGUMENT', 'Unsupported Gemini part', {
          reason: 'unsupported_part'
        });
      }

      if (roleBlocks.length > 0) {
        contextBlocks.push(`${role}:\n${roleBlocks.join('\n\n')}`);
      }
    }

    const prompt = contextBlocks.join('\n\n---\n\n');
    const generationConfig = body.generationConfig && typeof body.generationConfig === 'object'
      ? body.generationConfig
      : {};

    return {
      runId,
      runDir,
      systemInstruction,
      prompt,
      imagePaths,
      generationConfig
    };
  } catch (error) {
    await fs.rm(runDir, { recursive: true, force: true });
    throw error;
  }
}
