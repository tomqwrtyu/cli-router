import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { HttpError } from './errors.js';

export function providerCommand(normalized, modelEntry, config, options = {}) {
  if (modelEntry.provider === 'claude') {
    const outputFormat = options.stream ? 'stream-json' : 'text';
    const args = [
      '-p',
      '--output-format',
      outputFormat,
      ...(options.stream ? ['--include-partial-messages', '--verbose'] : []),
      '--safe-mode',
      '--no-session-persistence',
      '--disable-slash-commands',
      '--permission-mode',
      'dontAsk',
      '--tools',
      '',
      '--model',
      modelEntry.cliModel
    ];
    if (normalized.systemInstruction) {
      if (!normalized.systemInstructionPath) {
        throw new HttpError(500, 'INTERNAL', 'Materialized system prompt is missing', {
          reason: 'system_prompt_file_missing',
          provider: modelEntry.provider
        });
      }
      args.push('--system-prompt-file', normalized.systemInstructionPath);
    }
    return { command: config.providerBinaries.claude, args, stdin: normalized.prompt };
  }

  if (modelEntry.provider === 'codex') {
    const args = [
      ...(config.codexLiveSearch && normalized.webSearchEnabled !== false ? ['--search'] : []),
      'exec',
      '--ephemeral',
      '--ignore-user-config',
      '--ignore-rules',
      '--skip-git-repo-check',
      '--sandbox',
      'read-only',
      '--cd',
      normalized.runDir,
      '--model',
      modelEntry.cliModel,
      '-c',
      `model_reasoning_effort=${JSON.stringify(modelEntry.reasoningEffort)}`,
      '-c',
      `model_context_window=${modelEntry.contextWindow}`,
      '-c',
      `model_auto_compact_token_limit=${modelEntry.autoCompactTokenLimit}`
    ];
    const stdin = normalized.systemInstruction
      ? [
          '<application_instructions>',
          normalized.systemInstruction,
          '</application_instructions>',
          '',
          '<conversation>',
          normalized.prompt,
          '</conversation>'
        ].join('\n')
      : normalized.prompt;
    if (options.stream) args.push('--json');
    args.push(
      '-c',
      'developer_instructions="Follow the application_instructions block from stdin, then answer the conversation. Return only the answer."'
    );
    for (const imagePath of normalized.imagePaths) {
      args.push('--image', imagePath);
    }
    args.push('-');
    return { command: config.providerBinaries.codex, args, stdin };
  }

  throw new HttpError(400, 'INVALID_ARGUMENT', `Unsupported provider: ${modelEntry.provider}`);
}

function isQuotaOutput(output) {
  const lower = output.toLowerCase();
  return (
    lower.includes('rate limit') ||
    lower.includes('quota') ||
    lower.includes('usage limit') ||
    lower.includes('session limit')
  );
}

function isContextLimitOutput(output) {
  const lower = output.toLowerCase();
  return (
    lower.includes('context window') ||
    lower.includes('input_too_large') ||
    lower.includes('input exceeds the maximum length') ||
    lower.includes('prompt is too long')
  );
}

function normalizeProviderError(provider, output, code) {
  if (isContextLimitOutput(output)) {
    return new HttpError(413, 'INVALID_ARGUMENT', 'Input exceeds the provider context limit', {
      reason: 'context_length_exceeded',
      provider
    });
  }
  if (isQuotaOutput(output)) {
    return new HttpError(429, 'RESOURCE_EXHAUSTED', 'Provider quota exceeded or temporarily rate limited', {
      reason: 'provider_quota_exceeded',
      provider
    });
  }
  return new HttpError(502, 'UNAVAILABLE', `Provider CLI failed with exit code ${code}`, {
    reason: 'provider_cli_failed',
    provider,
    diagnosticHash: crypto.createHash('sha256').update(output).digest('hex'),
    diagnosticLength: Buffer.byteLength(output)
  });
}

function emptyProviderError(provider, diagnostic = '') {
  if (isContextLimitOutput(diagnostic) || isQuotaOutput(diagnostic)) {
    return normalizeProviderError(provider, diagnostic, 0);
  }
  if (diagnostic) {
    const diagnosticHash = crypto.createHash('sha256').update(diagnostic).digest('hex');
    console.error(
      `Provider CLI completed without output provider=${provider} diagnostic_hash=${diagnosticHash} diagnostic_bytes=${Buffer.byteLength(diagnostic)}`
    );
  }
  return new HttpError(502, 'UNAVAILABLE', 'Provider CLI completed without a response', {
    reason: 'provider_empty_output',
    provider
  });
}

function terminateProcessGroup(child, signal) {
  if (!child.pid) return;
  try {
    if (process.platform !== 'win32') process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
}

export function runCliOnce(normalized, modelEntry, config) {
  const { command, args, stdin } = providerCommand(normalized, modelEntry, config);
  const hasStdin = stdin !== undefined;

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: normalized.runDir,
      stdio: [hasStdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        NO_COLOR: '1'
      },
      detached: process.platform !== 'win32'
    });

    const stdout = [];
    const stderr = [];
    const timeout = setTimeout(() => {
      terminateProcessGroup(child, 'SIGTERM');
      setTimeout(() => terminateProcessGroup(child, 'SIGKILL'), 2_000).unref();
    }, config.runTimeoutMs);
    if (hasStdin) {
      child.stdin.end(stdin);
    }

    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.stdin?.on('error', (error) => {
      if (error.code !== 'EPIPE') {
        reject(new HttpError(502, 'UNAVAILABLE', `Failed to write provider input: ${error.message}`, {
          reason: 'provider_cli_stdin_failed',
          provider: modelEntry.provider
        }));
      }
    });
    child.on('error', (error) => {
      clearTimeout(timeout);
      reject(new HttpError(502, 'UNAVAILABLE', `Failed to start provider CLI: ${error.message}`, {
        reason: 'provider_cli_start_failed',
        provider: modelEntry.provider
      }));
    });
    child.on('close', (code, signal) => {
      clearTimeout(timeout);
      if (signal) {
        reject(new HttpError(504, 'DEADLINE_EXCEEDED', 'Provider CLI timed out', {
          reason: 'provider_timeout',
          provider: modelEntry.provider
        }));
        return;
      }
      const text = Buffer.concat(stdout).toString('utf8');
      const err = Buffer.concat(stderr).toString('utf8');
      if (code !== 0) {
        reject(normalizeProviderError(modelEntry.provider, `${err}\n${text}`.trim(), code));
        return;
      }
      if (!text.trim() && err.trim()) {
        reject(emptyProviderError(modelEntry.provider, err.trim()));
        return;
      }
      resolve(text.trim());
    });
  });
}

export function streamCli(normalized, modelEntry, config, onText, options = {}) {
  const { command, args, stdin } = providerCommand(normalized, modelEntry, config, { stream: true });
  const hasStdin = stdin !== undefined;

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: normalized.runDir,
      stdio: [hasStdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        NO_COLOR: '1'
      },
      detached: process.platform !== 'win32'
    });

    const stdout = [];
    const stderr = [];
    let terminationReason = null;
    let providerUsage = null;
    const terminate = (reason) => {
      if (terminationReason) return;
      terminationReason = reason;
      terminateProcessGroup(child, 'SIGTERM');
      setTimeout(() => terminateProcessGroup(child, 'SIGKILL'), 2_000).unref();
    };
    const timeout = setTimeout(() => terminate('timeout'), config.runTimeoutMs);
    const abortHandler = () => terminate(options.signal?.reason || 'cancelled');
    if (options.signal?.aborted) abortHandler();
    else options.signal?.addEventListener('abort', abortHandler, { once: true });
    if (hasStdin) {
      child.stdin.end(stdin);
    }

    let claudeLineBuffer = '';
    let claudeStreamError = '';
    const claudeDecoder = new StringDecoder('utf8');
    let codexLineBuffer = '';
    let codexStreamError = '';
    let codexSawAgentMessage = false;
    const codexDecoder = new StringDecoder('utf8');
    const handleClaudeLine = (line) => {
      if (!line.trim()) return;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        return;
      }
      const delta = event.type === 'stream_event' ? event.event?.delta : null;
      if (event.event?.type === 'content_block_delta' && delta?.type === 'text_delta' && delta.text) {
        onText(delta.text);
      }
      if (event.type === 'error' || (event.type === 'result' && event.is_error)) {
        claudeStreamError = event.error?.message || event.result || JSON.stringify(event);
      }
      if (event.type === 'result' && event.usage) {
        providerUsage = {
          promptTokenCount: Number(event.usage.input_tokens || 0),
          candidatesTokenCount: Number(event.usage.output_tokens || 0),
          totalTokenCount: Number(event.usage.input_tokens || 0) + Number(event.usage.output_tokens || 0),
          cacheReadTokenCount: Number(event.usage.cache_read_input_tokens || 0),
          cacheWriteTokenCount: Number(event.usage.cache_creation_input_tokens || 0),
          estimated: false,
          usageSource: 'provider'
        };
      }
    };
    const handleCodexLine = (line) => {
      if (!line.trim()) return;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        return;
      }
      if (event.type === 'item.completed' && event.item?.type === 'agent_message' && event.item.text) {
        codexSawAgentMessage = true;
        onText(event.item.text);
      }
      if (event.type === 'item.started' || event.type === 'item.completed') {
        const itemType = event.item?.type;
        if (itemType && itemType !== 'agent_message' && itemType !== 'reasoning') {
          options.onEvent?.({ type: 'provider_status', status: event.type, itemType });
        }
      }
      if (event.type === 'turn.completed' && event.usage) {
        const input = Number(event.usage.input_tokens || 0);
        const output = Number(event.usage.output_tokens || 0);
        providerUsage = {
          promptTokenCount: input,
          candidatesTokenCount: output,
          totalTokenCount: input + output,
          cachedInputTokenCount: Number(event.usage.cached_input_tokens || 0),
          reasoningTokenCount: Number(event.usage.reasoning_tokens || 0),
          estimated: false,
          usageSource: 'provider'
        };
      }
      if (event.type === 'error' || event.type === 'turn.failed') {
        codexStreamError = event.error?.message || event.message || JSON.stringify(event);
      }
    };

    child.stdout.on('data', (chunk) => {
      stdout.push(chunk);
      if (modelEntry.provider === 'claude') {
        claudeLineBuffer += claudeDecoder.write(chunk);
        const lines = claudeLineBuffer.split('\n');
        claudeLineBuffer = lines.pop() || '';
        for (const line of lines) handleClaudeLine(line);
        return;
      }
      if (modelEntry.provider === 'codex') {
        codexLineBuffer += codexDecoder.write(chunk);
        const lines = codexLineBuffer.split('\n');
        codexLineBuffer = lines.pop() || '';
        for (const line of lines) handleCodexLine(line);
        return;
      }
      const text = Buffer.concat(stdout).toString('utf8');
      if (!isQuotaOutput(text)) onText(chunk.toString('utf8'));
    });
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.stdin?.on('error', (error) => {
      if (error.code !== 'EPIPE') {
        reject(new HttpError(502, 'UNAVAILABLE', `Failed to write provider input: ${error.message}`, {
          reason: 'provider_cli_stdin_failed',
          provider: modelEntry.provider
        }));
      }
    });
    child.on('error', (error) => {
      clearTimeout(timeout);
      options.signal?.removeEventListener('abort', abortHandler);
      reject(new HttpError(502, 'UNAVAILABLE', `Failed to start provider CLI: ${error.message}`, {
        reason: 'provider_cli_start_failed',
        provider: modelEntry.provider
      }));
    });
    child.on('close', (code, signal) => {
      clearTimeout(timeout);
      options.signal?.removeEventListener('abort', abortHandler);
      if (modelEntry.provider === 'claude') {
        claudeLineBuffer += claudeDecoder.end();
        if (claudeLineBuffer) handleClaudeLine(claudeLineBuffer);
      }
      if (modelEntry.provider === 'codex') {
        codexLineBuffer += codexDecoder.end();
        if (codexLineBuffer) handleCodexLine(codexLineBuffer);
      }
      if (terminationReason === 'timeout') {
        reject(new HttpError(504, 'DEADLINE_EXCEEDED', 'Provider CLI timed out', {
          reason: 'provider_timeout',
          provider: modelEntry.provider
        }));
        return;
      }
      if (terminationReason) {
        const outputLimit = terminationReason === 'max_tokens';
        reject(new HttpError(outputLimit ? 413 : 499, outputLimit ? 'RESOURCE_EXHAUSTED' : 'CANCELLED', outputLimit
          ? 'Provider output reached the configured limit'
          : 'Provider generation was cancelled', {
          reason: outputLimit ? 'output_limit_reached' : 'provider_cancelled',
          provider: modelEntry.provider
        }));
        return;
      }
      if (signal) {
        reject(new HttpError(502, 'UNAVAILABLE', 'Provider CLI terminated unexpectedly', {
          reason: 'provider_cli_terminated',
          provider: modelEntry.provider
        }));
        return;
      }
      const err = Buffer.concat(stderr).toString('utf8');
      const text = Buffer.concat(stdout).toString('utf8');
      if (code !== 0) {
        reject(normalizeProviderError(modelEntry.provider, `${err}\n${text}`.trim(), code));
        return;
      }
      if (claudeStreamError) {
        reject(normalizeProviderError(modelEntry.provider, claudeStreamError, code));
        return;
      }
      if (codexStreamError) {
        reject(normalizeProviderError(modelEntry.provider, codexStreamError, code));
        return;
      }
      if (modelEntry.provider === 'codex' && !codexSawAgentMessage) {
        reject(emptyProviderError(modelEntry.provider, `${err}\n${text}`.trim()));
        return;
      }
      if (!text.trim() && err.trim()) {
        reject(emptyProviderError(modelEntry.provider, err.trim()));
        return;
      }
      resolve({ usageMetadata: providerUsage });
    });
  });
}
