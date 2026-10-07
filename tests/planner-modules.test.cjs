// Direct tests of the modules the agentic planner composes (the redacted planning inventory and the model runtime)
// and of how the planner loads them: as CommonJS siblings under Node and as globals in side-panel script order.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const plannerInventory = require('../shared/planner-inventory.js');
const plannerRuntime = require('../shared/planner-runtime.js');
const planner = require('../shared/agentic-planner.js');
const engine = require('../shared/form-engine.js');

const root = path.resolve(__dirname, '..');
const PLANNER_MODULES = ['shared/planner-inventory.js', 'shared/planner-runtime.js', 'shared/agentic-planner.js'];
const TOKEN = 'pairing-token-0123456789abcdef';

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

/** A fake Chrome LanguageModel that records each role session it creates and how many prompts overlap. */
function fakeLanguageModel(created) {
  return {
    async availability() { return 'available'; },
    async create(options) {
      const session = {
        system: options.initialPrompts[0].content,
        destroyed: false,
        active: 0,
        maxActive: 0,
        async clone() {
          const clone = {
            contextUsage: 10,
            contextWindow: 4096,
            async prompt(input) {
              session.active += 1;
              session.maxActive = Math.max(session.maxActive, session.active);
              await new Promise((resolve) => setTimeout(resolve, 5));
              session.active -= 1;
              clone.contextUsage += input.length;
              return `{"echo":${JSON.stringify(input)}}`;
            },
            destroy() {},
          };
          return clone;
        },
        destroy() { session.destroyed = true; },
      };
      created.push(session);
      return session;
    },
  };
}

test.afterEach(() => {
  plannerRuntime.setRuntimeForTests(null);
  plannerRuntime.setBridgeFetchForTests(null);
});

test('the planner API keeps its keys and delegates to the runtime and inventory modules', () => {
  assert.deepEqual(Object.keys(planner), [
    'availability', 'configure', 'gatewayConfig', 'groupedInventory', 'plan', 'prepare', 'reset', 'runtimeInfo',
    'setBridgeFetchForTests', 'setRuntimeForTests',
  ]);
  assert.equal(planner.groupedInventory, plannerInventory.groupedInventory);
  ['availability', 'configure', 'prepare', 'reset', 'runtimeInfo', 'setBridgeFetchForTests', 'setRuntimeForTests']
    .forEach((name) => assert.equal(planner[name], plannerRuntime[name], name));
  assert.deepEqual(plannerRuntime.ROLE_NAMES, ['field_mapper', 'gap_analyst', 'form_reviewer']);
});

test('the planning inventory redacts participant values from labels, questions and options, and lists sources without values', () => {
  const participant = {
    participant: { name: { first: 'Celeste', last: 'Thomas' }, ssn: '123-45-6789' },
    contact_information: { email: 'c.thomas+wic@example.org' },
  };
  const rawFields = [
    { fieldKey: 'first', type: 'text', label: 'First name for CELESTE', question: 'Is Celeste Thomas applying?', required: true },
    { fieldKey: 'contact', type: 'select-one', label: 'Contact', options: [{ label: 'Email c.thomas+wic@example.org' }, { label: 'Phone' }] },
    { fieldKey: 'ssn', type: 'text', label: 'SSN 123-45-6789', value: '123-45-6789' },
    { fieldKey: 'yes', groupKey: 'pregnant', type: 'radio', label: 'Yes', question: 'Is Thomas pregnant?', optionLabel: 'Yes' },
    { fieldKey: 'no', groupKey: 'pregnant', type: 'radio', label: 'No', optionLabel: 'No', checked: true },
  ];

  const { fields, sources } = plannerInventory.planningInventory(engine, participant, rawFields);
  const visible = JSON.stringify({ fields, sources });
  ['celeste', 'thomas', '123-45-6789', 'c.thomas+wic@example.org'].forEach((value) => assert.equal(visible.toLowerCase().includes(value), false, value));
  assert.equal(fields[0].label, 'First name for [source value]');
  assert.equal(fields[0].question, 'Is [source value] applying?');
  assert.deepEqual(fields[1].options, ['Email [source value]', 'Phone']);
  assert.equal(fields[2].alreadyFilled, true);
  assert.equal(Object.hasOwn(fields[2], 'value'), false);
  assert.deepEqual(fields[3], {
    fieldKey: 'pregnant', type: 'radio', label: 'Yes', question: 'Is [source value] pregnant?', required: false,
    alreadyFilled: true, purposeHint: '', allowRepeatedPurpose: false, options: ['Yes', 'No'],
  });
  assert.deepEqual(sources.map((source) => source.purpose), ['firstName', 'lastName', 'fullName', 'ssn', 'email']);
  sources.forEach((source) => assert.deepEqual(Object.keys(source), ['purpose', 'label', 'kind', 'sensitive']));
  assert.deepEqual(sources.filter((source) => source.sensitive).map((source) => source.purpose), ['ssn']);
});

test('inventory text is whitespace-collapsed and bounded, and a singleton group keeps its writable field key', () => {
  assert.equal(plannerInventory.compactText('  First \n\t name  '), 'First name');
  assert.equal(plannerInventory.compactText('x'.repeat(300)).length, 240);
  assert.equal(plannerInventory.compactText('abcdef', 3), 'abc');
  assert.equal(plannerInventory.compactText(undefined), '');
  const [single] = plannerInventory.groupedInventory([{ fieldKey: 'agree', groupKey: 'consent', type: 'checkbox', label: 'I agree' }]);
  assert.equal(single.fieldKey, 'agree');
});

test('the companion runtime accepts only a loopback http endpoint and a pairing token, and a rejected change keeps the old runtime', () => {
  const loopbackOnly = /must use http:\/\/127\.0\.0\.1 or http:\/\/localhost/;
  ['http://example.com:4174', 'https://127.0.0.1:4174', 'http://user:secret@127.0.0.1:4174', 'http://127.0.0.2:4174',
    'http://[::1]:4174', 'http://localhost.example.com:4174'].forEach((endpoint) => {
    assert.throws(() => plannerRuntime.configure({ kind: 'local-cli', provider: 'codex', token: TOKEN, endpoint }), loopbackOnly, endpoint);
  });
  assert.throws(() => plannerRuntime.configure({ kind: 'local-cli', provider: 'codex', token: TOKEN, endpoint: 'not a url' }), /valid localhost model-companion address/);
  assert.throws(() => plannerRuntime.configure({ kind: 'local-cli', provider: 'gemini', token: TOKEN }), /Choose Codex or Claude/);
  assert.throws(() => plannerRuntime.configure({ kind: 'local-cli', provider: 'codex', token: 'too-short' }), /pairing token/);
  assert.throws(() => plannerRuntime.configure({ kind: 'remote-api' }), /supported model runtime/);
  assert.equal(plannerRuntime.runtimeInfo().kind, 'chrome-local');

  assert.deepEqual(plannerRuntime.configure({
    kind: 'local-cli', provider: 'codex', token: `  ${TOKEN}  `, endpoint: 'http://localhost:4174/bridge/?debug=1#top', model: '  gpt   large ',
  }), {
    kind: 'local-cli',
    provider: 'codex',
    endpoint: 'http://localhost:4174/bridge',
    model: 'gpt large',
    title: 'Codex CLI subscription',
    detail: 'Codex CLI runs through the paired localhost companion and the signed-in subscription allowance.',
  });
});

test('the runtime owns the role sessions: one per role with its system prompt, reset by every test hook and provider change', async () => {
  const created = [];
  plannerRuntime.setRuntimeForTests(fakeLanguageModel(created));
  assert.deepEqual(await plannerRuntime.prepare(), { status: 'ready', agents: plannerRuntime.ROLE_NAMES });
  assert.equal(created.length, 3);
  assert.match(created[0].system, /^You are the field-mapping agent in Nava's form-completion system\./);
  assert.match(created[0].system, /Do not propose submit, signature, certification, CAPTCHA, login, payment, or\none-time-code actions\./);
  assert.match(created[1].system, /^You are the gap-analysis agent in Nava's form-completion system\./);
  assert.match(created[1].system, /Do not guess eligibility, protected, identity, income,/);
  assert.match(created[2].system, /^You are the independent form-review agent in Nava's form-completion\nsystem\./);
  assert.match(created[2].system, /Do not approve final actions or bot challenges\./);
  created.forEach((session) => assert.match(session.system, /Return only\sschema-constrained\sdata\.$/));

  await plannerRuntime.prepare();
  assert.equal(created.length, 3);
  planner.setRuntimeForTests(fakeLanguageModel(created));
  assert.ok(created.slice(0, 3).every((session) => session.destroyed));
  await planner.prepare();
  assert.equal(created.length, 6);

  plannerRuntime.configure({ kind: 'chrome-local' });
  assert.ok(created.slice(3).every((session) => !session.destroyed));
  plannerRuntime.configure({ kind: 'local-cli', provider: 'claude', token: TOKEN });
  assert.ok(created.slice(3).every((session) => session.destroyed));
});

test('prompts to one role never overlap, and each reports value-free usage', async () => {
  const created = [];
  plannerRuntime.setRuntimeForTests(fakeLanguageModel(created));
  await plannerRuntime.prepare();
  const [first, second, gaps] = await Promise.all([
    plannerRuntime.promptRole('field_mapper', 'one', { type: 'object' }),
    plannerRuntime.promptRole('field_mapper', 'three', { type: 'object' }),
    plannerRuntime.promptRole('gap_analyst', 'four', { type: 'object' }),
  ]);
  assert.equal(created[0].maxActive, 1);
  assert.equal(first.text, '{"echo":"one"}');
  assert.equal(second.text, '{"echo":"three"}');
  assert.equal(gaps.usage.role, 'gap_analyst');
  const { durationMs, ...usage } = second.usage;
  assert.ok(Number.isFinite(durationMs));
  assert.deepEqual(usage, {
    role: 'field_mapper', prompts: 1, inputCharacters: 5, outputCharacters: 16, contextUsageUnits: 5, contextWindow: 4096,
    inputTokens: null, outputTokens: null, apiCostUsd: 0, providerReportedCostUsd: null,
  });
});

test('side-panel script order loads the inventory, then the runtime, then the planner, which runs on their globals', async () => {
  const sidePanelShared = [...read('sidepanel/index.html').matchAll(/<script\b[^>]*\bsrc="\.\.\/(shared\/[^"?#]+)/g)].map((match) => match[1]);
  const positions = PLANNER_MODULES.map((file) => sidePanelShared.indexOf(file));
  assert.ok(positions.every((position, index) => position >= 0 && (index === 0 || position > positions[index - 1])), sidePanelShared.join(', '));

  const context = vm.createContext({ URL });
  PLANNER_MODULES.forEach((file) => vm.runInContext(read(file), context, { filename: file }));
  const browserPlanner = context.NavaAgenticPlanner;
  assert.deepEqual(Object.keys(browserPlanner), Object.keys(planner));
  assert.equal(browserPlanner.groupedInventory, context.NavaPlannerInventory.groupedInventory);
  assert.equal(browserPlanner.configure, context.NavaPlannerRuntime.configure);
  assert.equal(browserPlanner.runtimeInfo().kind, 'chrome-local');
  assert.equal(await browserPlanner.availability(), 'unavailable');

  const withoutModules = vm.createContext({ URL });
  assert.throws(
    () => vm.runInContext(read('shared/agentic-planner.js'), withoutModules, { filename: 'shared/agentic-planner.js' }),
    (error) => error.name === 'TypeError',
  );
  assert.equal(withoutModules.NavaAgenticPlanner, undefined);
});

test('redaction keeps form vocabulary whole and never marks the client\'s choice among the options', () => {
  // Fictional demo record 339619: preferred contact "Email", a household member whose relationship is "Child".
  const { CLIENT_RECORDS } = require('../shared/demo-connector-data.js');
  const participant = CLIENT_RECORDS.find((record) => JSON.stringify(record).includes('339619'));
  const rawFields = [
    { fieldKey: 'care', type: 'radio', label: 'Yes', question: 'Is the household paying for childcare?', optionLabel: 'Yes' },
    { fieldKey: 'contact', type: 'select-one', label: 'Email', question: 'How should we contact Celeste?', options: [{ label: 'Email' }, { label: 'Phone' }, { label: 'Mail' }] },
    { fieldKey: 'email', type: 'email', label: 'Email address (testnava@email.com on file)' },
  ];
  const { fields } = plannerInventory.planningInventory(engine, participant, rawFields);
  assert.equal(fields[0].question, 'Is the household paying for childcare?', 'a relationship value never eats part of a word');
  assert.equal(fields[1].label, 'Email');
  assert.deepEqual(fields[1].options, ['Email', 'Phone', 'Mail'], 'no option is singled out as the client\'s answer');
  assert.equal(fields[1].question, 'How should we contact [source value]?', 'names are still redacted');
  assert.equal(fields[2].label, 'Email address ([source value] on file)', 'contact details are still redacted');
});
