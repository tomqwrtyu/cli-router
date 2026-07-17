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

export function geminiTextResponse(text, finishReason = 'STOP', usageMetadata = null) {
  return {
    candidates: [
      {
        content: {
          role: 'model',
          parts: [{ text }]
        },
        finishReason
      }
    ],
    ...(usageMetadata ? { usageMetadata } : {})
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

export function geminiDoneChunk(usageMetadata = null) {
  return {
    candidates: [
      {
        content: {
          role: 'model',
          parts: []
        },
        finishReason: 'STOP'
      }
    ],
    ...(usageMetadata ? { usageMetadata } : {})
  };
}

export function estimateUsageMetadata(normalized, outputText, config) {
  const images = Array.isArray(normalized.images) ? normalized.images : [];
  const imageCount = images.length;
  const inputChars = [normalized.systemInstruction, normalized.prompt]
    .filter(Boolean)
    .join('\n')
    .length;
  const imageTokenDetails = images.map((image) => estimateImagePromptTokens(image, config));
  const imageTokenCount = imageTokenDetails.reduce((total, image) => total + image.tokenCount, 0);
  const promptTokenCount = Math.ceil(inputChars / 4) + imageTokenCount;
  const candidatesTokenCount = Math.ceil((outputText || '').length / 4);
  return {
    promptTokenCount,
    candidatesTokenCount,
    totalTokenCount: promptTokenCount + candidatesTokenCount,
    estimated: true,
    imageCount,
    imageTokenCount,
    ...(imageCount > 0
      ? {
          imageTokenDetails,
          imageTokenEstimateConfig: {
            smallImageMaxPixels: config.usage.imageSmallMaxPixels,
            tileSizePixels: config.usage.imageTileSize,
            tokensPerTile: config.usage.imageTileTokens,
            maxTokens: config.usage.imageMaxTokens,
            fallbackTokens: config.usage.imageFallbackTokens
          }
        }
      : {})
  };
}

function estimateImagePromptTokens(image, config) {
  const dimensions = image?.dimensions;
  if (
    dimensions &&
    Number.isFinite(dimensions.width) &&
    Number.isFinite(dimensions.height) &&
    dimensions.width > 0 &&
    dimensions.height > 0
  ) {
    if (
      dimensions.width <= config.usage.imageSmallMaxPixels &&
      dimensions.height <= config.usage.imageSmallMaxPixels
    ) {
      return {
        tokenCount: applyImageTokenCap(config.usage.imageTileTokens, config),
        estimateMethod: 'gemini-small-image',
        width: dimensions.width,
        height: dimensions.height,
        tileCount: 1
      };
    }

    const horizontalTiles = Math.max(1, Math.ceil(dimensions.width / config.usage.imageTileSize));
    const verticalTiles = Math.max(1, Math.ceil(dimensions.height / config.usage.imageTileSize));
    const tileCount = horizontalTiles * verticalTiles;
    const uncappedTokenCount = tileCount * config.usage.imageTileTokens;
    const tokenCount = applyImageTokenCap(uncappedTokenCount, config);
    return {
      tokenCount,
      estimateMethod: 'gemini-tile-estimate',
      width: dimensions.width,
      height: dimensions.height,
      tileSizePixels: config.usage.imageTileSize,
      horizontalTiles,
      verticalTiles,
      tileCount,
      ...(tokenCount !== uncappedTokenCount ? { uncappedTokenCount } : {})
    };
  }
  return {
    tokenCount: applyImageTokenCap(config.usage.imageFallbackTokens, config),
    estimateMethod: 'fallback'
  };
}

function applyImageTokenCap(tokenCount, config) {
  if (config.usage.imageMaxTokens > 0) return Math.min(config.usage.imageMaxTokens, tokenCount);
  return tokenCount;
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
  const systemInstructionPath = systemInstruction ? path.join(runDir, 'system-prompt.txt') : null;
  const contextBlocks = [];
  const imagePaths = [];
  const images = [];

  try {
    if (systemInstructionPath) {
      await fs.writeFile(systemInstructionPath, systemInstruction, { mode: 0o600 });
    }
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
            images.push({
              path: materialized.path,
              mimeType: materialized.mimeType,
              name: materialized.name,
              byteLength: materialized.byteLength,
              dimensions: materialized.dimensions
            });
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
      systemInstructionPath,
      prompt,
      imagePaths,
      images,
      generationConfig
    };
  } catch (error) {
    await fs.rm(runDir, { recursive: true, force: true });
    throw error;
  }
}
