const test = require('node:test');
const assert = require('node:assert/strict');
const engine = require('../shared/form-engine.js');
const planner = require('../shared/agentic-planner.js');

function runtimeFor({ reviewerApproved, reviewerRejected, mapperConfidence = 'high', mapperMappings, gapItems, rawOutput = {} } = {}) {
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
          if (rawOutput[role] !== undefined) return rawOutput[role];
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
            rejected: reviewerRejected || [],
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

test('a configured Nava API plans the page and the extension drops mappings the inventory does not support', async () => {
  const previousFetch = globalThis.fetch;
  globalThis.NAVA_PLAN_GATEWAY = { endpoint: 'https://api.test/v1/plan', token: 'nava_test_secret' };
  let sent = null;
  globalThis.fetch = async (url, init) => {
    sent = { url, body: JSON.parse(init.body), authorization: init.headers.authorization };
    return {
      ok: true,
      async json() {
        return {
          ok: true,
          plan: {
            purposeOverrides: { first: 'firstName', ssn: 'firstName' },
            approved: [],
            rejected: [],
            gaps: [{ fieldKey: 'pregnancy', question: 'Are you pregnant?', reason: 'No source.' }],
            metadata: { runtime: 'gateway:claude-sonnet-4-6' },
          },
        };
      },
    };
  };
  try {
    const result = await planner.plan({
      engine,
      page: { domain: 'ruhealth.org' },
      rawFields,
      participant: { participant: { name: { first: 'Celeste', last: 'Thomas' } } },
    });
    assert.equal(sent.url, 'https://api.test/v1/plan');
    assert.equal(sent.authorization, 'Bearer nava_test_secret');
    assert.equal(JSON.stringify(sent.body).includes('Celeste'), false);
    assert.equal(result.purposeOverrides.first, 'firstName');
    assert.equal(result.purposeOverrides.ssn, undefined);
    assert.equal(result.metadata.mode, 'shared-engine');
  } finally {
    globalThis.fetch = previousFetch;
    globalThis.NAVA_PLAN_GATEWAY = null;
  }
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

// Runtime/gateway resolution step.

test('refuses to plan without a usable form engine and never starts a model or gateway call', async () => {
  const runtime = runtimeFor();
  planner.setRuntimeForTests(runtime);
  await assert.rejects(planner.plan({ rawFields }), /The form engine is unavailable\./);
  await assert.rejects(planner.plan({ engine: { canonicalizeParticipant() {} }, rawFields }), /The form engine is unavailable\./);
  assert.equal(runtime.createCount, 0);
  assert.equal(runtime.prompts.length, 0);
});

test('resolves the shared gateway from extension storage and falls back to local roles without a token', async () => {
  const previousChrome = globalThis.chrome;
  const previousFetch = globalThis.fetch;
  let stored = { navaApiBase: 'https://api.test/', navaApiToken: 'nava_stored_secret', navaPlanModel: 'planner-large' };
  let requestedKeys = null;
  globalThis.chrome = { storage: { local: { async get(keys) { requestedKeys = keys; return stored; } } } };
  let sent = null;
  globalThis.fetch = async (url, init) => {
    sent = { url, body: JSON.parse(init.body), authorization: init.headers.authorization };
    return { ok: true, async json() { return { ok: true, plan: { purposeOverrides: {}, gaps: [] } }; } };
  };
  try {
    assert.deepEqual(await planner.gatewayConfig(), {
      endpoint: 'https://api.test/v1/plan',
      token: 'nava_stored_secret',
      model: 'planner-large',
    });
    assert.deepEqual(requestedKeys, ['navaApiBase', 'navaApiToken', 'navaPlanModel']);
    const viaGateway = await planner.plan({ engine, page: { domain: 'example.gov' }, rawFields, participant: {} });
    assert.equal(sent.url, 'https://api.test/v1/plan');
    assert.equal(sent.authorization, 'Bearer nava_stored_secret');
    assert.equal(sent.body.model, 'planner-large');
    assert.equal(viaGateway.metadata.runtime, 'nava-api');
    assert.equal(viaGateway.metadata.mode, 'shared-engine');

    stored = { navaApiBase: 'https://api.test', navaApiToken: '' };
    sent = null;
    assert.equal(await planner.gatewayConfig(), null);
    const runtime = runtimeFor();
    planner.setRuntimeForTests(runtime);
    const local = await planner.plan({ engine, page: { domain: 'example.gov' }, rawFields, participant: {} });
    assert.equal(sent, null);
    assert.equal(runtime.createCount, 3);
    assert.equal(local.metadata.mode, 'on-device-multi-agent');
  } finally {
    globalThis.chrome = previousChrome;
    globalThis.fetch = previousFetch;
  }
});

// Redacted source inventory step.

test('participant values never reach any role prompt, including option text, grouped choices, and regex-special values', async () => {
  const runtime = runtimeFor({ mapperMappings: [], gapItems: [], reviewerApproved: [] });
  planner.setRuntimeForTests(runtime);
  const participant = {
    participant: { name: { first: 'Celeste', last: 'Thomas' }, ssn: '123-45-6789' },
    contact_information: { email: 'c.thomas+wic@example.org' },
  };
  await planner.plan({
    engine,
    page: { title: 'Application for Celeste Thomas', domain: 'example.gov' },
    rawFields: [
      { fieldKey: 'applicant', type: 'select-one', label: 'Applicant (CELESTE)', question: 'Who is applying?', options: [{ label: 'Celeste Thomas' }, { value: 'thomas' }] },
      { fieldKey: 'contact-email', groupKey: 'contact', type: 'radio', label: 'Email', question: 'Send notices to c.thomas+wic@example.org?', optionLabel: 'Use c.thomas+wic@example.org' },
      { fieldKey: 'contact-mail', groupKey: 'contact', type: 'radio', label: 'Mail', question: 'Send notices to c.thomas+wic@example.org?', optionLabel: 'Use postal mail' },
      { fieldKey: 'ssn-confirm', type: 'text', label: 'Confirm SSN ending 123-45-6789', question: '', required: true },
    ],
    participant,
  });

  assert.equal(runtime.prompts.length, 3);
  assert.deepEqual(runtime.prompts.map((entry) => entry.role).sort(), ['gaps', 'mapper', 'reviewer']);
  runtime.prompts.forEach(({ role, input }) => {
    assert.doesNotMatch(input, /celeste|thomas|123-45-6789|example\.org/i, `${role} prompt leaked a participant value`);
    assert.match(input, /\[source value\]/, `${role} prompt should carry the redaction marker`);
  });
  const mapperInput = JSON.parse(runtime.prompts.find((entry) => entry.role === 'mapper').input);
  assert.deepEqual(mapperInput.page, { domain: 'example.gov' });
  assert.deepEqual(mapperInput.availableSources.find((source) => source.purpose === 'ssn'), {
    purpose: 'ssn',
    label: 'Social Security Number',
    kind: 'string',
    sensitive: true,
  });
  assert.deepEqual(mapperInput.fields.find((field) => field.fieldKey === 'contact').options, ['Use [source value]', 'Use postal mail']);
});

// Mapper, gap-analyst and reviewer role steps.

test('an unreadable role response aborts the plan before any mapping is returned', async () => {
  const mapperRuntime = runtimeFor({ rawOutput: { mapper: 'not json' } });
  planner.setRuntimeForTests(mapperRuntime);
  const phases = [];
  await assert.rejects(
    planner.plan({ engine, page: { domain: 'example.gov' }, rawFields, participant: {}, onProgress: (event) => phases.push(event.phase) }),
    /The field-mapping agent returned an unreadable plan\. No form values were changed\./,
  );
  assert.ok(phases.includes('planning'));
  assert.equal(phases.includes('reviewing'), false);
  assert.equal(mapperRuntime.prompts.some((entry) => entry.role === 'reviewer'), false);

  planner.setRuntimeForTests(runtimeFor({ rawOutput: { gaps: '{"gaps":' } }));
  await assert.rejects(
    planner.plan({ engine, page: { domain: 'example.gov' }, rawFields, participant: {} }),
    /The gap-analysis agent returned an unreadable plan\./,
  );

  planner.setRuntimeForTests(runtimeFor({ rawOutput: { reviewer: '' } }));
  await assert.rejects(
    planner.plan({ engine, page: { domain: 'example.gov' }, rawFields, participant: {} }),
    /The form-review agent returned an unreadable plan\./,
  );
});

// Validation step.

test('reviewer-rejected mappings are dropped, and a field keeps only its first approved purpose', async () => {
  const runtime = runtimeFor({
    mapperMappings: [
      { fieldKey: 'first', purpose: 'firstName', confidence: 'high', reason: 'First-name label.' },
      { fieldKey: 'first', purpose: 'fullName', confidence: 'medium', reason: 'Could be a full name.' },
      { fieldKey: 'last', purpose: 'lastName', confidence: 'high', reason: 'Last-name label.' },
    ],
    gapItems: [],
    reviewerApproved: [
      { fieldKey: 'first', purpose: 'firstName', reason: 'The label is exact.' },
      { fieldKey: 'first', purpose: 'fullName', reason: 'Also plausible.' },
    ],
    reviewerRejected: [{ fieldKey: 'last', purpose: 'lastName', reason: 'The label names a different person.' }],
  });
  planner.setRuntimeForTests(runtime);
  const result = await planner.plan({
    engine,
    page: { domain: 'example.gov' },
    rawFields: [
      { fieldKey: 'first', type: 'text', label: 'First name', required: true },
      { fieldKey: 'last', type: 'text', label: "Parent's last name", required: true },
    ],
    participant: { participant: { name: { first: 'Celeste', last: 'Thomas' } } },
  });

  assert.deepEqual(result.purposeOverrides, { first: 'firstName' });
  assert.deepEqual(result.approved.map((item) => [item.fieldKey, item.purpose]), [['first', 'firstName']]);
  assert.deepEqual(result.rejected[0], { fieldKey: 'last', purpose: 'lastName', reason: 'The label names a different person.' });
  assert.equal(result.rejected[1].fieldKey, 'first');
  assert.equal(result.rejected[1].purpose, 'fullName');
  assert.match(result.rejected[1].reason, /duplicate/);
  assert.equal(result.metadata.proposedMappings, 3);
  assert.equal(result.metadata.approvedMappings, 1);
  assert.equal(result.metadata.rejectedMappings, 2);
  assert.equal(result.metadata.summary, 'One exact mapping was approved.');
});

test('proposed gaps survive only for known, empty fields that still need a caseworker answer', async () => {
  const runtime = runtimeFor({
    mapperMappings: [{ fieldKey: 'first', purpose: 'firstName', confidence: 'high', reason: 'First-name label.' }],
    reviewerApproved: [{ fieldKey: 'first', purpose: 'firstName', reason: 'Exact label.' }],
    gapItems: [
      { fieldKey: 'first', question: 'What is the first name?', reason: 'Answered by an approved mapping.' },
      { fieldKey: 'nickname', question: 'Any nickname?', reason: 'Optional free text.' },
      { fieldKey: 'filled', question: 'What is the case number?', reason: 'Already on the page.' },
      { fieldKey: 'ghost', question: 'Unknown?', reason: 'Not in the inventory.' },
      { fieldKey: 'pregnancy', question: 'Is the client pregnant?', reason: 'A choice with no source.' },
      { fieldKey: 'agree', question: 'Does the client agree?', reason: 'A checkbox decision.' },
      { fieldKey: 'appointment-video', question: 'Video appointments?', reason: 'Site-hinted, but no source answer.' },
      { fieldKey: 'city', question: `Which city? ${'x'.repeat(400)}`, reason: 'Required, no source.' },
    ],
  });
  planner.setRuntimeForTests(runtime);
  const result = await planner.plan({
    engine,
    page: { domain: 'example.gov' },
    rawFields: [
      { fieldKey: 'first', type: 'text', label: 'First name', required: true },
      { fieldKey: 'nickname', type: 'text', label: 'Nickname' },
      { fieldKey: 'filled', type: 'text', label: 'Case number', required: true, value: 'on page' },
      rawFields[1],
      rawFields[2],
      { fieldKey: 'agree', type: 'checkbox', label: 'I agree' },
      { fieldKey: 'appointment-video', type: 'checkbox', label: 'Telehealth (video)', purpose: 'wicAppointmentVideo' },
      { fieldKey: 'city', type: 'text', label: 'City', required: true },
    ],
    participant: { participant: { name: { first: 'Celeste' } } },
  });

  assert.deepEqual(result.purposeOverrides, { first: 'firstName', 'appointment-video': 'wicAppointmentVideo' });
  assert.deepEqual(result.gaps.map((gap) => gap.fieldKey), ['pregnancy', 'agree', 'appointment-video', 'city']);
  assert.equal(result.gaps[3].question.length, 280);
});

// Gateway clamp.

test('a gateway plan is clamped to the inventory, the canonical purposes, and the sources on file', async () => {
  const previousFetch = globalThis.fetch;
  globalThis.NAVA_PLAN_GATEWAY = { endpoint: 'https://api.test/v1/plan', token: 'nava_test_secret' };
  let sent = null;
  globalThis.fetch = async (url, init) => {
    sent = JSON.parse(init.body);
    return {
      ok: true,
      async json() {
        return {
          ok: true,
          plan: {
            purposeOverrides: {
              first: 'firstName',
              ghost: 'firstName',
              pregnancy: 'notACanonicalPurpose',
              'child-under-five': 'wicChildUnderFive',
              'appointment-video': 'wicAppointmentVideo',
            },
            approved: [{ fieldKey: 'child-under-five', purpose: 'wicChildUnderFive', source: 'site-adapter' }],
            rejected: [{ fieldKey: 'last', purpose: 'lastName', reason: 'Gateway reviewer rejected it.' }],
            gaps: [
              { fieldKey: 'first', question: 'First name?', reason: 'Mapped already.' },
              { fieldKey: 'ghost', question: 'Ghost?', reason: 'Not on the page.' },
              { fieldKey: 'pregnancy', question: 'Is the client pregnant?', reason: 'No source.' },
            ],
          },
        };
      },
    };
  };
  try {
    const result = await planner.plan({
      engine,
      page: { domain: 'ruhealth.org' },
      rawFields: [
        ...rawFields,
        { fieldKey: 'child-under-five', type: 'checkbox', label: 'Children 0-5' },
        { fieldKey: 'appointment-video', type: 'checkbox', label: 'Telehealth (video)' },
      ],
      participant: { participant: { name: { first: 'Celeste' } } },
    });

    assert.deepEqual(result.purposeOverrides, { first: 'firstName', 'child-under-five': 'wicChildUnderFive' });
    assert.deepEqual(result.approved.map((item) => item.fieldKey), ['first', 'child-under-five']);
    assert.deepEqual(
      result.rejected.map((item) => [item.fieldKey, item.purpose]),
      [['last', 'lastName'], ['ghost', 'firstName'], ['pregnancy', 'notACanonicalPurpose'], ['appointment-video', 'wicAppointmentVideo']],
    );
    assert.deepEqual(result.gaps.map((gap) => gap.fieldKey), ['pregnancy']);
    assert.equal(result.metadata.runtime, 'nava-api');
    assert.equal(result.metadata.mode, 'shared-engine');
    assert.deepEqual(sent.sources, [{ purpose: 'firstName', label: 'First name', kind: 'string', sensitive: false }, { purpose: 'fullName', label: 'Full name', kind: 'string', sensitive: false }]);
    assert.equal(JSON.stringify(sent).includes('Celeste'), false);
  } finally {
    globalThis.fetch = previousFetch;
    globalThis.NAVA_PLAN_GATEWAY = null;
  }
});

test('a failed gateway response stops planning with a safe error', async () => {
  const previousFetch = globalThis.fetch;
  globalThis.NAVA_PLAN_GATEWAY = { endpoint: 'https://api.test/v1/plan', token: 'nava_test_secret' };
  try {
    globalThis.fetch = async () => ({ ok: false, async json() { return { ok: false, error: 'The shared planner is over quota.' }; } });
    await assert.rejects(planner.plan({ engine, page: { domain: 'example.gov' }, rawFields, participant: {} }), /over quota/);
    globalThis.fetch = async () => ({ ok: true, async json() { throw new Error('not json'); } });
    await assert.rejects(
      planner.plan({ engine, page: { domain: 'example.gov' }, rawFields, participant: {} }),
      /The shared planner did not return a plan\. No form values were changed\./,
    );
  } finally {
    globalThis.fetch = previousFetch;
    globalThis.NAVA_PLAN_GATEWAY = null;
  }
});

// Metadata and usage step.

function meteredRuntime(readings) {
  const outputs = {
    mapper: JSON.stringify({ mappings: [] }),
    gaps: JSON.stringify({ gaps: [] }),
    reviewer: JSON.stringify({ approved: [], rejected: [], summary: 'Nothing to approve.' }),
  };
  const prompts = [];
  return {
    prompts,
    outputs,
    async availability() { return 'available'; },
    async create(options) {
      const system = options.initialPrompts[0].content;
      const role = system.includes('field-mapping') ? 'mapper'
        : system.includes('gap-analysis') ? 'gaps'
          : 'reviewer';
      const reading = readings[role] || {};
      return {
        async clone() {
          let used = reading.before;
          return {
            get contextUsage() { return used; },
            contextWindow: reading.window,
            async prompt(input) {
              prompts.push(input);
              used = reading.after;
              return outputs[role];
            },
            destroy() {},
          };
        },
        destroy() {},
      };
    },
  };
}

test('on-device usage sums each role and turns unknown once any role cannot report context usage', async () => {
  const runtime = meteredRuntime({
    mapper: { before: 100, after: 140, window: 6000 },
    gaps: { before: 300, after: 250, window: 6000 },
    reviewer: { before: 50, after: 80, window: 6000 },
  });
  planner.setRuntimeForTests(runtime);
  const result = await planner.plan({ engine, page: { domain: 'example.gov' }, rawFields, participant: {} });
  const { usage } = result.metadata;

  assert.equal(usage.prompts, 3);
  assert.equal(usage.contextUsageUnits, 70);
  assert.equal(usage.inputCharacters, runtime.prompts.reduce((total, input) => total + input.length, 0));
  assert.equal(usage.outputCharacters, Object.values(runtime.outputs).reduce((total, text) => total + text.length, 0));
  assert.equal(usage.inputTokens, null);
  assert.equal(usage.outputTokens, null);
  assert.equal(usage.providerReportedCostUsd, null);
  assert.equal(usage.apiCostUsd, 0);
  assert.ok(Number.isFinite(usage.durationMs));
  assert.equal(result.metadata.provider, 'chrome-local');
  assert.equal(result.metadata.runtime, 'chrome-gemini-nano');
  assert.deepEqual(result.metadata.agents, ['field_mapper', 'gap_analyst', 'form_reviewer']);
  assert.ok(!Number.isNaN(Date.parse(result.metadata.reviewedAt)));

  planner.setRuntimeForTests(meteredRuntime({
    mapper: { before: 100, after: 140 },
    gaps: { before: 300, after: 350 },
    reviewer: {},
  }));
  const partial = await planner.plan({ engine, page: { domain: 'example.gov' }, rawFields, participant: {} });
  assert.equal(partial.metadata.usage.contextUsageUnits, null);
  assert.equal(partial.metadata.usage.prompts, 3);
});

test('companion usage sums reported tokens and cost, and a token count any role omits stays unknown', async () => {
  const roleResults = {
    field_mapper: { mappings: [] },
    gap_analyst: { gaps: [] },
    form_reviewer: { approved: [], rejected: [], summary: 'Nothing to approve.' },
  };
  const roleUsage = {
    field_mapper: { inputTokens: 40, outputTokens: 10, durationMs: 25, providerReportedCostUsd: 0.25 },
    gap_analyst: { inputTokens: '35', outputTokens: 5, durationMs: 20, providerReportedCostUsd: 0.5 },
    form_reviewer: { inputTokens: 50, durationMs: 30, providerReportedCostUsd: 0.25 },
  };
  planner.setBridgeFetchForTests(async (url, options = {}) => {
    if (url.endsWith('/health')) {
      return { ok: true, status: 200, async json() { return { ok: true, providers: { claude: { installed: true, subscription: true } } }; } };
    }
    const { role } = JSON.parse(options.body);
    return {
      ok: true,
      status: 200,
      async json() { return { ok: true, text: JSON.stringify(roleResults[role]), usage: roleUsage[role] }; },
    };
  });
  planner.configure({
    kind: 'local-cli',
    provider: 'claude',
    endpoint: 'http://localhost:4174/',
    token: 'test-pairing-token-with-32-characters',
  });

  const result = await planner.plan({ engine, page: { domain: 'example.gov' }, rawFields, participant: {} });
  const { usage } = result.metadata;

  assert.equal(result.metadata.runtime, 'claude-cli-subscription');
  assert.equal(result.metadata.provider, 'claude');
  assert.equal(usage.prompts, 3);
  assert.equal(usage.inputTokens, 125);
  assert.equal(usage.outputTokens, null);
  assert.equal(usage.durationMs, 75);
  assert.equal(usage.providerReportedCostUsd, 1);
  assert.equal(usage.contextUsageUnits, null);
  assert.equal(usage.apiCostUsd, 0);
});
