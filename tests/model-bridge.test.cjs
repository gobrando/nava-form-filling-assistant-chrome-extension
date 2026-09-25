const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');

const VALID_REQUEST = {
  provider: 'claude',
  role: 'field_mapper',
  systemPrompt: 'Map form controls. Return only JSON.',
  prompt: '{"fields":[{"label":"First name"}]}',
  responseSchema: {
    type: 'object',
    properties: { mappings: { type: 'array', items: { type: 'object' } } },
    required: ['mappings'],
  },
  model: 'sonnet',
};

test('subscription bridge allowlists roles and creates no shell command', async () => {
  const bridge = await import('../model-bridge/core.mjs');
  assert.throws(() => bridge.validateRoleRequest({ ...VALID_REQUEST, role: 'arbitrary_shell_agent' }), /not allowed/);
  const validated = bridge.validateRoleRequest(VALID_REQUEST);
  const invocation = bridge.commandForProvider(validated, {
    tempDirectory: '/tmp/nava-test',
    schemaPath: '/tmp/nava-test/schema.json',
    outputPath: '/tmp/nava-test/output.json',
  });
  assert.equal(invocation.command, 'claude');
  assert.ok(invocation.args.includes('--safe-mode'));
  assert.ok(invocation.args.includes('--tools'));
  assert.equal(invocation.args[invocation.args.indexOf('--tools') + 1], '');
  assert.equal(invocation.input, VALID_REQUEST.prompt);
  assert.doesNotMatch(invocation.args.join(' '), /First name/);
});

test('Codex subscription invocation is ephemeral, read-only, schema constrained, and stdin based', async () => {
  const bridge = await import('../model-bridge/core.mjs');
  const validated = bridge.validateRoleRequest({ ...VALID_REQUEST, provider: 'codex', model: '' });
  const invocation = bridge.commandForProvider(validated, {
    tempDirectory: '/tmp/nava-test',
    schemaPath: '/tmp/nava-test/schema.json',
    outputPath: '/tmp/nava-test/output.json',
  });
  assert.equal(invocation.command, 'codex');
  assert.ok(invocation.args.includes('--ephemeral'));
  assert.equal(invocation.args[invocation.args.indexOf('--sandbox') + 1], 'read-only');
  assert.ok(invocation.args.includes('--json'));
  assert.ok(invocation.args.includes('--output-schema'));
  assert.equal(invocation.args.at(-1), '-');
  assert.match(invocation.input, /Do not use tools/);
  assert.doesNotMatch(invocation.args.join(' '), /First name/);
});

test('Codex JSONL usage parser captures subscription token counts', async () => {
  const bridge = await import('../model-bridge/core.mjs');
  const usage = bridge.parseCodexUsage([
    JSON.stringify({ type: 'thread.started', thread_id: 'test' }),
    JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 321, cached_input_tokens: 12, output_tokens: 45 } }),
  ].join('\n'));
  assert.equal(usage.inputTokens, 321);
  assert.equal(usage.outputTokens, 45);
  assert.equal(usage.providerReportedCostUsd, null);
});

test('Claude runner strips API-key billing variables and parses structured usage', async () => {
  const bridge = await import('../model-bridge/core.mjs');
  let captured = null;
  function fakeSpawn(command, args, options) {
    captured = { command, args, options, input: '' };
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.kill = () => {};
    child.stdin.on('data', (chunk) => { captured.input += chunk.toString('utf8'); });
    child.stdin.on('finish', () => {
      child.stdout.end(JSON.stringify({
        result: '{"mappings":[]}',
        usage: { input_tokens: 12, output_tokens: 4 },
        total_cost_usd: 0,
      }));
      child.stderr.end();
      setImmediate(() => child.emit('close', 0));
    });
    return child;
  }

  const result = await bridge.runRoleRequest(VALID_REQUEST, {
    spawnImpl: fakeSpawn,
    environment: { PATH: process.env.PATH, ANTHROPIC_API_KEY: 'must-not-be-used' },
  });

  assert.equal(result.text, '{"mappings":[]}');
  assert.equal(result.usage.inputTokens, 12);
  assert.equal(result.usage.outputTokens, 4);
  assert.equal(captured.options.shell, false);
  assert.equal(captured.options.env.ANTHROPIC_API_KEY, undefined);
  assert.equal(captured.input, VALID_REQUEST.prompt);
});
