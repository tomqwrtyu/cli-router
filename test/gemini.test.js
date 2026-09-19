import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { assertPromptWithinModelLimits, estimateTextTokens, normalizeGeminiRequest } from '../src/gemini.js';

const usageConfig = {
  usage: {
    imageSmallMaxPixels: 384,
    imageTileSize: 768,
    imageTileTokens: 258,
    imageMaxTokens: 0,
    imageFallbackTokens: 258
  }
};

const attachmentConfig = (tmpDir) => ({
  tmpDir,
  attachments: {
    allowedFileUriHosts: [],
    allowInsecureFileUris: false,
    downloadTimeoutMs: 1_000,
    maxImageBytes: 15 * 1024 * 1024,
    maxDocBytes: 10 * 1024 * 1024,
    maxPdfBytes: 10 * 1024 * 1024,
    maxDocTextChars: 50_000,
    allowedImageMime: ['image/png', 'image/jpeg', 'image/webp'],
    allowedDocMime: ['application/json', 'text/plain', 'application/pdf']
  }
});

test('token estimation accounts for UTF-8 text more conservatively than chars/4', () => {
  assert.equal(estimateTextTokens(' x'.repeat(10)), 10);
  assert.equal(estimateTextTokens('測'.repeat(10)), 15);
});

test('prompt preflight enforces character and estimated token limits', () => {
  const normalized = {
    systemInstruction: 'system',
    prompt: ' x'.repeat(10),
    images: []
  };

  assert.throws(
    () => assertPromptWithinModelLimits(normalized, {
      cliModel: 'test-model',
      inputCharLimit: 100,
      inputTokenLimit: 12
    }, usageConfig),
    (error) => error.statusCode === 413 && error.details.reason === 'context_length_exceeded'
  );

  assert.throws(
    () => assertPromptWithinModelLimits(normalized, {
      cliModel: 'test-model',
      inputCharLimit: 10,
      inputTokenLimit: 100
    }, usageConfig),
    (error) => error.statusCode === 413 && error.details.inputChars > 10
  );
});

test('Gemini normalization materializes the system instruction in the run directory', async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'cli-router-test-'));
  let normalized;
  try {
    normalized = await normalizeGeminiRequest({
      systemInstruction: { parts: [{ text: 'Application system instruction' }] },
      contents: [{ role: 'user', parts: [{ text: 'Hello' }] }]
    }, { tmpDir }, { provider: 'claude', supportsImages: false });

    assert.equal(normalized.systemInstruction, 'Application system instruction');
    assert.equal(
      await readFile(normalized.systemInstructionPath, 'utf8'),
      normalized.systemInstruction
    );
    assert.equal(path.dirname(normalized.systemInstructionPath), normalized.runDir);
  } finally {
    if (normalized?.runDir) await rm(normalized.runDir, { recursive: true, force: true });
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test('Gemini normalization retains verified image bytes for Claude stream-json stdin', async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'cli-router-image-test-'));
  const pngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
  let normalized;
  try {
    normalized = await normalizeGeminiRequest({
      contents: [{
        role: 'user',
        parts: [
          { inlineData: { mimeType: 'image/png', data: pngBase64 } },
          { text: 'Describe this image' }
        ]
      }]
    }, attachmentConfig(tmpDir), { provider: 'claude', supportsImages: true });

    assert.equal(normalized.images.length, 1);
    assert.equal(normalized.images[0].mimeType, 'image/png');
    assert.equal(normalized.images[0].base64Data, pngBase64);
    assert.equal(normalized.imagePaths.length, 1);
    assert.match(normalized.prompt, /Describe this image/);
  } finally {
    if (normalized?.runDir) await rm(normalized.runDir, { recursive: true, force: true });
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test('Gemini normalization accepts an explicit router web-search preference', async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'cli-router-test-'));
  let normalized;
  try {
    normalized = await normalizeGeminiRequest({
      routerConfig: { webSearchEnabled: false },
      contents: [{ role: 'user', parts: [{ text: 'Extract this document' }] }]
    }, { tmpDir }, { provider: 'codex', supportsImages: true });

    assert.equal(normalized.webSearchEnabled, false);
  } finally {
    if (normalized?.runDir) await rm(normalized.runDir, { recursive: true, force: true });
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test('Gemini normalization rejects a non-boolean router web-search preference', async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'cli-router-test-'));
  try {
    await assert.rejects(
      normalizeGeminiRequest({
        routerConfig: { webSearchEnabled: 'false' },
        contents: [{ role: 'user', parts: [{ text: 'Extract this document' }] }]
      }, { tmpDir }, { provider: 'codex', supportsImages: true }),
      (error) => error.statusCode === 400 && error.details.reason === 'invalid_router_config'
    );
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});
