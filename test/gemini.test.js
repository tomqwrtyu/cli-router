import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { normalizeGeminiRequest } from '../src/gemini.js';

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
