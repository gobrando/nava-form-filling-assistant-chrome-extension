import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const ALLOWED_ROLES = new Set(['field_mapper', 'gap_analyst', 'form_reviewer']);
const MAX_PROMPT_BYTES = 64 * 1024;
const MAX_SCHEMA_BYTES = 32 * 1024;
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 120_000;

function boundedText(value, limit, label) {
  const text = String(value || '');
  if (!text.trim()) throw new Error(`${label} is required.`);
  if (Buffer.byteLength(text, 'utf8') > limit) throw new Error(`${label} is too large.`);
  return text;
}

export function validateRoleRequest(value = {}) {
  const provider = String(value.provider || '');
  if (!['codex', 'claude'].includes(provider)) throw new Error('Choose the Codex or Claude companion provider.');
  const role = String(value.role || '');
  if (!ALLOWED_ROLES.has(role)) throw new Error('The requested model role is not allowed.');
  const systemPrompt = boundedText(value.systemPrompt, MAX_PROMPT_BYTES, 'The role instructions');
  const prompt = boundedText(value.prompt, MAX_PROMPT_BYTES, 'The minimized page prompt');
  const responseSchema = value.responseSchema;
  if (!responseSchema || typeof responseSchema !== 'object' || Array.isArray(responseSchema)) {
    throw new Error('A JSON response schema is required.');
  }
  const schemaText = JSON.stringify(responseSchema);
  if (Buffer.byteLength(schemaText, 'utf8') > MAX_SCHEMA_BYTES) throw new Error('The response schema is too large.');
  const model = String(value.model || '').trim().slice(0, 120);
  return { provider, role, systemPrompt, prompt, responseSchema, schemaText, model };
}

function subscriptionOnlyEnvironment(provider, source = process.env) {
  const env = { ...source };
  if (provider === 'codex') {
    delete env.OPENAI_API_KEY;
    delete env.AZURE_OPENAI_API_KEY;
  } else {
    delete env.ANTHROPIC_API_KEY;
    delete env.ANTHROPIC_AUTH_TOKEN;
    delete env.CLAUDE_CODE_USE_BEDROCK;
    delete env.CLAUDE_CODE_USE_VERTEX;
    delete env.CLAUDE_CODE_USE_FOUNDRY;
  }
  return env;
}

export function commandForProvider(request, paths) {
  if (request.provider === 'codex') {
    const args = [
      'exec',
      '--skip-git-repo-check',
      '--ephemeral',
      '--sandbox', 'read-only',
      '--ignore-user-config',
      '--ignore-rules',
      '--json',
      '--output-schema', paths.schemaPath,
      '--output-last-message', paths.outputPath,
      '--color', 'never',
      '--cd', paths.tempDirectory,
    ];
    if (request.model) args.push('--model', request.model);
    args.push('-');
    return {
      command: 'codex',
      args,
      input: `${request.systemPrompt}\n\nDo not use tools or inspect files. Complete only this schema-constrained classification task.\n\n${request.prompt}`,
    };
  }

  const args = [
    '--print',
    '--safe-mode',
    '--tools', '',
    '--permission-mode', 'dontAsk',
    '--no-session-persistence',
    '--no-chrome',
    '--output-format', 'json',
    '--json-schema', request.schemaText,
    '--system-prompt', request.systemPrompt,
  ];
  if (request.model) args.push('--model', request.model);
  return { command: 'claude', args, input: request.prompt };
}

export function spawnCaptured(command, args, {
  input = '',
  cwd,
  env = process.env,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  spawnImpl = spawn,
} = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnImpl(command, args, {
      cwd,
      env,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let outputBytes = 0;
    let settled = false;
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
    };
    const append = (kind, chunk) => {
      outputBytes += chunk.length;
      if (outputBytes > MAX_OUTPUT_BYTES) {
        child.kill('SIGKILL');
        finish(() => reject(new Error('The model companion produced too much output.')));
        return;
      }
      if (kind === 'stdout') stdout += chunk.toString('utf8');
      else stderr += chunk.toString('utf8');
    };
    child.stdout.on('data', (chunk) => append('stdout', chunk));
    child.stderr.on('data', (chunk) => append('stderr', chunk));
    child.once('error', (error) => finish(() => reject(error)));
    child.once('close', (code) => finish(() => {
      if (code !== 0) {
        const summary = stderr.replace(/\s+/g, ' ').trim().slice(0, 600);
        reject(new Error(summary || `${command} exited with code ${code}.`));
        return;
      }
      resolve({ stdout, stderr, code });
    }));
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(() => reject(new Error(`The ${command} model call timed out.`)));
    }, timeoutMs);
    child.stdin.end(input);
  });
}

function numberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function parseClaudeResult(stdout) {
  let envelope;
  try {
    envelope = JSON.parse(stdout);
  } catch {
    throw new Error('Claude Code returned unreadable JSON.');
  }
  const structured = envelope.structured_output ?? envelope.structuredOutput;
  const rawResult = structured === undefined ? envelope.result : structured;
  const text = typeof rawResult === 'string' ? rawResult : JSON.stringify(rawResult);
  if (!text || text === 'undefined') throw new Error('Claude Code returned no structured result.');
  const usage = envelope.usage || {};
  return {
    text,
    inputTokens: numberOrNull(usage.input_tokens ?? usage.inputTokens),
    outputTokens: numberOrNull(usage.output_tokens ?? usage.outputTokens),
    providerReportedCostUsd: numberOrNull(envelope.total_cost_usd ?? envelope.totalCostUsd),
  };
}

export function parseCodexUsage(stdout) {
  const totals = { inputTokens: 0, outputTokens: 0 };
  let found = false;
  for (const line of String(stdout || '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    const usage = event.usage || event.token_usage || event.tokenUsage || event.data?.usage || {};
    const input = numberOrNull(
      usage.input_tokens
      ?? usage.inputTokens
      ?? usage.prompt_tokens
      ?? usage.promptTokens,
    );
    const output = numberOrNull(
      usage.output_tokens
      ?? usage.outputTokens
      ?? usage.completion_tokens
      ?? usage.completionTokens,
    );
    if (input !== null) {
      totals.inputTokens += input;
      found = true;
    }
    if (output !== null) {
      totals.outputTokens += output;
      found = true;
    }
  }
  return {
    inputTokens: found ? totals.inputTokens : null,
    outputTokens: found ? totals.outputTokens : null,
    providerReportedCostUsd: null,
  };
}

export async function runRoleRequest(value, {
  spawnImpl = spawn,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  environment = process.env,
} = {}) {
  const request = validateRoleRequest(value);
  const tempDirectory = await mkdtemp(join(tmpdir(), 'nava-model-bridge-'));
  const schemaPath = join(tempDirectory, 'response-schema.json');
  const outputPath = join(tempDirectory, 'last-message.json');
  const startedAt = Date.now();
  try {
    await writeFile(schemaPath, `${request.schemaText}\n`, { mode: 0o600 });
    const invocation = commandForProvider(request, { tempDirectory, schemaPath, outputPath });
    const result = await spawnCaptured(invocation.command, invocation.args, {
      input: invocation.input,
      cwd: tempDirectory,
      env: subscriptionOnlyEnvironment(request.provider, environment),
      timeoutMs,
      spawnImpl,
    });
    let parsed;
    if (request.provider === 'codex') {
      const text = await readFile(outputPath, 'utf8');
      parsed = { text: text.trim(), ...parseCodexUsage(result.stdout) };
    } else {
      parsed = parseClaudeResult(result.stdout);
    }
    JSON.parse(parsed.text);
    return {
      text: parsed.text,
      provider: request.provider,
      model: request.model || null,
      usage: {
        inputTokens: parsed.inputTokens,
        outputTokens: parsed.outputTokens,
        providerReportedCostUsd: parsed.providerReportedCostUsd,
        durationMs: Date.now() - startedAt,
      },
    };
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new Error(`${request.provider === 'codex' ? 'Codex CLI' : 'Claude Code'} is not installed or is not on PATH.`);
    }
    throw error;
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

export async function probeProvider(provider, { spawnImpl = spawn } = {}) {
  const command = provider === 'codex' ? 'codex' : 'claude';
  try {
    const result = await spawnCaptured(command, ['--version'], { timeoutMs: 5_000, spawnImpl });
    const statusArgs = provider === 'codex' ? ['login', 'status'] : ['auth', 'status', '--json'];
    let authenticated = false;
    let subscription = false;
    let authMode = 'none';
    try {
      const status = await spawnCaptured(command, statusArgs, { timeoutMs: 8_000, spawnImpl });
      if (provider === 'codex') {
        const summary = `${status.stdout}\n${status.stderr}`;
        authenticated = /logged in/i.test(summary);
        subscription = /logged in using chatgpt/i.test(summary);
        authMode = subscription ? 'chatgpt' : authenticated ? 'non-subscription' : 'none';
      } else {
        const parsed = JSON.parse(status.stdout);
        authenticated = Boolean(parsed.loggedIn);
        const method = String(parsed.authMethod || '').toLowerCase();
        const plan = String(parsed.subscriptionType || '').toLowerCase();
        subscription = authenticated && (Boolean(plan) || /claude|oauth|subscription/.test(method)) && !/api|console/.test(method);
        authMode = subscription ? (plan || method || 'claude-subscription') : authenticated ? 'non-subscription' : 'none';
      }
    } catch {
      // Installed but signed-out CLIs are reported without leaking account details.
    }
    return {
      installed: true,
      authenticated,
      subscription,
      authMode,
      version: result.stdout.replace(/\s+/g, ' ').trim().slice(0, 120),
    };
  } catch {
    return { installed: false, authenticated: false, subscription: false, authMode: 'none', version: '' };
  }
}
