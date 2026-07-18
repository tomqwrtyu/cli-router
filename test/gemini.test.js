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
