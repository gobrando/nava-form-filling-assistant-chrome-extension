const test = require('node:test');
const assert = require('node:assert/strict');
const engine = require('../shared/form-engine.js');
const planner = require('../shared/agentic-planner.js');

function runtimeFor({ reviewerApproved, mapperConfidence = 'high', mapperMappings, gapItems } = {}) {
  const prompts = [];
  let createCount = 0;
  const active = { mapper: 0, gaps: 0, reviewer: 0 };
  const maxActive = { mapper: 0, gaps: 0, reviewer: 0 };
  const runtime = {
    prompts,
    active,
    maxActive,
    get createCount() { return createCount; },
    async availability() { return 'available'; },
    async create(options) {
      createCount += 1;
      const system = options.initialPrompts[0].content;
      const role = system.includes('field-mapping') ? 'mapper'
        : system.includes('gap-analysis') ? 'gaps'
          : 'reviewer';
      const session = {
        async prompt(input) {
          prompts.push({ role, input });
          active[role] += 1;
          maxActive[role] = Math.max(maxActive[role], active[role]);
          await new Promise((resolve) => setTimeout(resolve, 5));
          active[role] -= 1;
          if (role === 'mapper') {
            return JSON.stringify({
              mappings: mapperMappings || [{ fieldKey: 'first', purpose: 'firstName', confidence: mapperConfidence, reason: 'First-name label.' }],
            });
          }
          if (role === 'gaps') {
            return JSON.stringify({
              gaps: gapItems || [{ fieldKey: 'pregnancy', question: 'Is the client pregnant?', reason: 'The record has no pregnancy answer.' }],
            });
          }
          return JSON.stringify({
            approved: reviewerApproved || [{ fieldKey: 'first', purpose: 'firstName', reason: 'The label is exact.' }],
            rejected: [],
            summary: 'One exact mapping was approved.',
          });
        },
        async clone() { return { prompt: session.prompt, destroy() {} }; },
        destroy() {},
      };
      return session;
    },
  };
  return runtime;
}

const rawFields = [
  { fieldKey: 'first', type: 'text', label: 'First name for Celeste', question: 'First name for Celeste', required: true },
  { fieldKey: 'pregnant-yes', groupKey: 'pregnancy', type: 'radio', label: 'Yes', question: 'Are you pregnant?', optionLabel: 'Yes', optionValue: 'yes' },
  { fieldKey: 'pregnant-no', groupKey: 'pregnancy', type: 'radio', label: 'No', question: 'Are you pregnant?', optionLabel: 'No', optionValue: 'no' },
];

test.afterEach(() => {
  planner.setRuntimeForTests(null);
  planner.setBridgeFetchForTests(null);
});

test('bounds the untrusted page inventory before it reaches a model prompt', () => {
  const inventory = planner.groupedInventory(Array.from({ length: 100 }, (_, index) => ({
    fieldKey: `field-${index}`,
    type: 'select-one',
    label: `Question ${index} ${'x'.repeat(400)}`,
    options: Array.from({ length: 100 }, (_unused, optionIndex) => ({ label: `Option ${optionIndex} ${'y'.repeat(200)}` })),
  })));

  assert.ok(inventory.length <= 80);
  assert.ok(JSON.stringify(inventory).length <= 24_000);
  assert.ok(inventory.every((field) => field.label.length <= 240));
});

test('uses three model roles, withholds client values, and returns only reviewer-approved mappings', async () => {
  const runtime = runtimeFor();
  planner.setRuntimeForTests(runtime);
  const result = await planner.plan({
    engine,
    page: { title: "Celeste's Application", domain: 'example.gov' },
    rawFields,
    participant: {
      participant: { name: { first: 'Celeste' }, ssn: '123-45-6789' },
      contact_information: { email: 'celeste@example.org' },
    },
  });

  assert.equal(runtime.createCount, 3);
  assert.deepEqual(result.purposeOverrides, { first: 'firstName' });
  assert.equal(result.metadata.mode, 'on-device-multi-agent');
  assert.equal(result.metadata.approvedMappings, 1);
  assert.equal(result.metadata.usage.prompts, 3);
  assert.equal(result.metadata.usage.apiCostUsd, 0);
  assert.equal(result.metadata.billing, 'on-device-no-token-charge');
  assert.equal(result.gaps[0].fieldKey, 'pregnancy');
  const modelInput = runtime.prompts.map((entry) => entry.input).join('\n');
  assert.match(modelInput, /firstName/);
  assert.doesNotMatch(modelInput, /Celeste|123-45-6789|celeste@example\.org/);
});

test('singleton checkbox mappings keep the writable field key and suppress stale model gaps', async () => {
  const runtime = runtimeFor({
    mapperMappings: [{
      fieldKey: 'child-under-five',
      purpose: 'wicChildUnderFive',
      confidence: 'high',
      reason: 'Exact site purpose hint.',
    }],
    gapItems: [{
      fieldKey: 'child-under-five',
      question: 'Should the child-under-five box be selected?',
      reason: 'Stale gap proposal from the pre-fill inventory.',
    }],
    reviewerApproved: [{
      fieldKey: 'child-under-five',
      purpose: 'wicChildUnderFive',
      reason: 'Exact site purpose hint.',
    }],
  });
  planner.setRuntimeForTests(runtime);
  const field = {
    fieldKey: 'child-under-five',
    groupKey: 'group:checkbox:please_select[child]',
    type: 'checkbox',
    label: 'Children/Toddler 0-5',
    question: 'Please select all that apply',
    purpose: 'wicChildUnderFive',
    checked: false,
    value: '',
  };

  const result = await planner.plan({
    engine,
    page: { domain: 'ruhealth.org' },
    rawFields: [field],
    participant: { programData: { wic: { childUnderFive: true } } },
  });

  assert.deepEqual(result.purposeOverrides, { 'child-under-five': 'wicChildUnderFive' });
  assert.deepEqual(result.gaps, []);
  const analysis = engine.buildAnalysis([field], { programData: { wic: { childUnderFive: true } } }, {
    purposeOverrides: result.purposeOverrides,
    requirePurposeOverrides: true,
  });
  assert.equal(analysis.assignments[0].fieldKey, 'child-under-five');
  assert.equal(analysis.assignments[0].value, 'yes');
});

test('versioned site-purpose hints remain authoritative when the local mapper omits them', async () => {
  const runtime = runtimeFor({
    mapperMappings: [],
    gapItems: [],
    reviewerApproved: [],
  });
  planner.setRuntimeForTests(runtime);
  const result = await planner.plan({
    engine,
    page: { domain: 'ruhealth.org' },
    rawFields: [{
      fieldKey: 'appointment-in-person',
      groupKey: 'group:checkbox:appointment[in-person]',
      type: 'checkbox',
      label: 'In-Person',
      question: 'I authorize my WIC appointments',
      purpose: 'wicAppointmentInPerson',
      checked: false,
      value: '',
    }],
    participant: { programData: { wic: { appointmentInPerson: true } } },
  });

  assert.deepEqual(result.purposeOverrides, { 'appointment-in-person': 'wicAppointmentInPerson' });
  assert.equal(result.metadata.trustedHintMappings, 1);
  assert.equal(result.approved[0].source, 'site-adapter');
});

test('a site-hinted checkbox with no source answer becomes a caseworker gap', async () => {
  const runtime = runtimeFor({ mapperMappings: [], gapItems: [], reviewerApproved: [] });
  planner.setRuntimeForTests(runtime);
  const field = {
    fieldKey: 'appointment-video',
    groupKey: 'group:checkbox:appointment[video]',
    type: 'checkbox',
    label: 'Telehealth (video)',
    question: 'I authorize my WIC appointments',
    purpose: 'wicAppointmentVideo',
    checked: false,
    value: '',
  };
  const result = await planner.plan({
    engine,
    page: { domain: 'ruhealth.org' },
    rawFields: [field],
    participant: {},
  });
  const analysis = engine.buildAnalysis([field], {}, {
    purposeOverrides: result.purposeOverrides,
    requirePurposeOverrides: true,
  });

  assert.deepEqual(result.purposeOverrides, { 'appointment-video': 'wicAppointmentVideo' });
  assert.equal(analysis.gaps.length, 1);
  assert.equal(analysis.gaps[0].inputType, 'choice');
  assert.deepEqual(analysis.gaps[0].options.map((option) => option.value), ['yes', 'no']);
});

test('group inventory reports a choice as filled when any group member is checked', () => {
  const inventory = planner.groupedInventory([
    { fieldKey: 'yes', groupKey: 'answer', type: 'radio', label: 'Yes', optionLabel: 'Yes', checked: false },
    { fieldKey: 'no', groupKey: 'answer', type: 'radio', label: 'No', optionLabel: 'No', checked: true },
  ]);

  assert.equal(inventory[0].alreadyFilled, true);
});

test('local policy rejects a reviewer mapping that the mapper never proposed', async () => {
  const runtime = runtimeFor({
    reviewerApproved: [
      { fieldKey: 'first', purpose: 'lastName', reason: 'Incorrect reviewer invention.' },
      { fieldKey: 'unknown-field', purpose: 'firstName', reason: 'Unknown field.' },
    ],
  });
  planner.setRuntimeForTests(runtime);
  const result = await planner.plan({
    engine,
    page: { title: 'Application', domain: 'example.gov' },
    rawFields,
    participant: { participant: { name: { first: 'Celeste', last: 'Thomas' } } },
  });

  assert.deepEqual(result.purposeOverrides, {});
  assert.equal(result.approved.length, 0);
  assert.equal(result.rejected.length, 2);
});

test('local policy rejects a low-confidence mapping even when the reviewer approves it', async () => {
  const runtime = runtimeFor({ mapperConfidence: 'low' });
  planner.setRuntimeForTests(runtime);
  const result = await planner.plan({
    engine,
    page: { title: 'Application', domain: 'example.gov' },
    rawFields,
    participant: { participant: { name: { first: 'Celeste' } } },
  });

  assert.deepEqual(result.purposeOverrides, {});
  assert.equal(result.rejected.length, 1);
  assert.match(result.rejected[0].reason, /low-confidence/);
});

test('parallel application plans never prompt the same model session concurrently', async () => {
  const runtime = runtimeFor();
  planner.setRuntimeForTests(runtime);
  const request = {
    engine,
    page: { title: 'Application', domain: 'example.gov' },
    rawFields,
    participant: { participant: { name: { first: 'Celeste' } } },
  };

  await Promise.all([planner.plan(request), planner.plan(request), planner.plan(request)]);

  assert.equal(runtime.createCount, 3);
  assert.deepEqual(runtime.maxActive, { mapper: 1, gaps: 1, reviewer: 1 });
});

test('routes the same redacted three-role plan through a paired subscription companion', async () => {
  const calls = [];
  planner.setBridgeFetchForTests(async (url, options = {}) => {
    calls.push({ url, options });
    if (url.endsWith('/health')) {
      return {
        ok: true,
        status: 200,
        async json() {
          return { ok: true, providers: { codex: { installed: true, subscription: true } } };
        },
      };
    }
    const body = JSON.parse(options.body);
    const roleResults = {
      field_mapper: { mappings: [{ fieldKey: 'first', purpose: 'firstName', confidence: 'high', reason: 'Exact first-name label.' }] },
      gap_analyst: { gaps: [{ fieldKey: 'pregnancy', question: 'Is the client pregnant?', reason: 'No safe source answer.' }] },
      form_reviewer: { approved: [{ fieldKey: 'first', purpose: 'firstName', reason: 'Exact label.' }], rejected: [], summary: 'Approved.' },
    };
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          ok: true,
          text: JSON.stringify(roleResults[body.role]),
          usage: { inputTokens: 40, outputTokens: 10, durationMs: 25, providerReportedCostUsd: null },
        };
      },
    };
  });
  planner.configure({
    kind: 'local-cli',
    provider: 'codex',
    endpoint: 'http://127.0.0.1:4174',
    token: 'test-pairing-token-with-32-characters',
  });

  const result = await planner.plan({
    engine,
    page: { title: "Celeste's Application", domain: 'example.gov' },
    rawFields,
    participant: {
      participant: { name: { first: 'Celeste' }, ssn: '123-45-6789' },
      contact_information: { email: 'celeste@example.org' },
    },
  });

  assert.equal(result.metadata.runtime, 'codex-cli-subscription');
  assert.equal(result.metadata.mode, 'localhost-subscription-multi-agent');
  assert.equal(result.metadata.billing, 'subscription-allowance-no-direct-api-key');
  assert.equal(result.metadata.usage.inputTokens, 120);
  assert.equal(result.metadata.usage.outputTokens, 30);
  assert.equal(result.metadata.usage.apiCostUsd, 0);
  assert.equal(calls.filter((call) => call.url.endsWith('/v1/role')).length, 3);
  assert.ok(calls.every((call) => call.options.headers.Authorization === 'Bearer test-pairing-token-with-32-characters'));
  const serializedBodies = calls.filter((call) => call.options.body).map((call) => call.options.body).join('\n');
  assert.doesNotMatch(serializedBodies, /Celeste|123-45-6789|celeste@example\.org/);
});
