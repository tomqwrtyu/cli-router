import { spawn } from 'node:child_process';
import { HttpError } from './errors.js';

function providerCommand(normalized, modelEntry, config) {
  if (modelEntry.provider === 'claude') {
    const args = [
      '-p',
      '--output-format',
      'text',
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
      args.push('--system-prompt', normalized.systemInstruction);
    }
    args.push(normalized.prompt);
    return { command: config.providerBinaries.claude, args };
  }

  if (modelEntry.provider === 'codex') {
    const args = [
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
      modelEntry.cliModel
    ];
    if (normalized.systemInstruction) {
      args.push('-c', `developer_instructions=${JSON.stringify(normalized.systemInstruction)}`);
    }
    for (const imagePath of normalized.imagePaths) {
      args.push('--image', imagePath);
    }
    args.push('-');
    return { command: config.providerBinaries.codex, args, stdin: normalized.prompt };
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

function normalizeProviderError(provider, output, code) {
  if (isQuotaOutput(output)) {
    return new HttpError(429, 'RESOURCE_EXHAUSTED', 'Provider quota exceeded or temporarily rate limited', {
      reason: 'provider_quota_exceeded',
      provider
    });
  }
  return new HttpError(502, 'UNAVAILABLE', `Provider CLI failed with exit code ${code}`, {
    reason: 'provider_cli_failed',
    provider,
    stderr: output.slice(-2000)
  });
}

export function runCliOnce(normalized, modelEntry, config) {
  const { command, args, stdin } = providerCommand(normalized, modelEntry, config);

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: normalized.runDir,
      stdio: [stdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        NO_COLOR: '1'
      }
    });

    const stdout = [];
    const stderr = [];
    const timeout = setTimeout(() => {
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 2_000).unref();
    }, config.runTimeoutMs);
    if (stdin) {
      child.stdin.end(stdin);
    }

    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
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
      resolve(text.trim());
    });
  });
}

export function streamCli(normalized, modelEntry, config, onText) {
  const { command, args, stdin } = providerCommand(normalized, modelEntry, config);

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: normalized.runDir,
      stdio: [stdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        NO_COLOR: '1'
      }
    });

    const stdout = [];
    const stderr = [];
    const timeout = setTimeout(() => {
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 2_000).unref();
    }, config.runTimeoutMs);
    if (stdin) {
      child.stdin.end(stdin);
    }

    child.stdout.on('data', (chunk) => {
      stdout.push(chunk);
      const text = Buffer.concat(stdout).toString('utf8');
      if (!isQuotaOutput(text)) {
        onText(chunk.toString('utf8'));
      }
    });
    child.stderr.on('data', (chunk) => stderr.push(chunk));
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
      const err = Buffer.concat(stderr).toString('utf8');
      const text = Buffer.concat(stdout).toString('utf8');
      if (code !== 0) {
        reject(normalizeProviderError(modelEntry.provider, `${err}\n${text}`.trim(), code));
        return;
      }
      resolve();
    });
  });
}
