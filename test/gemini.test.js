import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
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

test('aggregate attachment budget counts inline documents across all messages', async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'router-batch-budget-'));
  const part = { inlineData: { mimeType: 'text/plain', data: Buffer.from('12345').toString('base64') } };
  try {
    await assert.rejects(normalizeGeminiRequest({ routerConfig: { maxAttachmentBytes: 9 },
      contents: [{ role: 'user', parts: [part] }, { role: 'user', parts: [part] }]
    }, attachmentConfig(tmpDir), {}), error => error.statusCode === 413);
    assert.deepEqual(await readdir(tmpDir), []);
    const normalized = await normalizeGeminiRequest({ routerConfig: { maxAttachmentBytes: 10 },
      contents: [{ role: 'user', parts: [part, part] }]
    }, attachmentConfig(tmpDir), {});
    assert.match(normalized.prompt, /12345/);
  } finally { await rm(tmpDir, { recursive: true, force: true }); }
});

test('download budget checks actual bytes even when Content-Length lies', async () => {
  const originalFetch = globalThis.fetch;
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'router-fetch-budget-'));
  const config = attachmentConfig(tmpDir);
  config.attachments.allowedFileUriHosts = ['storage.invalid'];
  let calls = 0;
  globalThis.fetch = async () => { calls++; return new Response('12345', { headers: { 'content-length': '1' } }); };
  const part = { fileData: { mimeType: 'text/plain', fileUri: 'https://storage.invalid/test.txt' } };
  try {
    await assert.rejects(normalizeGeminiRequest({ routerConfig: { maxAttachmentBytes: 9 },
      contents: [{ role: 'user', parts: [part, part] }]
    }, config, {}), error => error.statusCode === 413);
    assert.equal(calls, 2);
    assert.deepEqual(await readdir(tmpDir), []);
  } finally { globalThis.fetch = originalFetch; await rm(tmpDir, { recursive: true, force: true }); }
});

test('invalid aggregate attachment budgets are rejected before materialization', async () => {
  for (const maxAttachmentBytes of [0, -1, 1.5, '30', 30 * 1024 * 1024 + 1]) {
    await assert.rejects(normalizeGeminiRequest({ routerConfig: { maxAttachmentBytes },
      contents: [{ role: 'user', parts: [{ text: 'test' }] }]
    }, {}, {}), error => error.statusCode === 400 && error.details.reason === 'invalid_router_config');
  }
});
