const test = require('node:test');
const assert = require('node:assert/strict');

const scanAnalysis = require('../sidepanel/scan-analysis.js');
const policyRules = require('../sidepanel/application-policy.js');
const format = require('../sidepanel/panel-format.js');
const workQueueEngine = require('../shared/work-queue-engine.js');

const record = scanAnalysis.create({
  signatureHash: workQueueEngine.signatureHash,
  hostLabel: format.hostLabel,
  provenanceForScan: format.provenanceForScan,
  urlOrigin: policyRules.urlOrigin,
  urlPath: policyRules.urlPath,
  commandLocation: policyRules.commandLocation,
});

test('BenefitsCal scans carry the caseworker program selection; other applications send the record unchanged', () => {
  const participant = { record_id: '339619' };
  const selected = scanAnalysis.participantForApplication(participant, { workflowId: 'benefitscal', programIds: ['calfresh', 'calworks'] });
  assert.deepEqual(selected.applicationSelection, { calfresh: true, medical: false, calworks: true });
  assert.equal(selected.record_id, '339619');
  assert.equal(participant.applicationSelection, undefined, 'the stored participant is never mutated');

  assert.equal(scanAnalysis.participantForApplication(participant, { workflowId: 'riverside-wic', programIds: ['wic'] }), participant);
  assert.equal(scanAnalysis.participantForApplication(participant, { workflowId: 'benefitscal', programIds: ['calfresh'], programSelectionRequired: true }), participant);
  assert.equal(scanAnalysis.participantForApplication(participant, { workflowId: 'benefitscal' }), participant);
  assert.equal(scanAnalysis.participantForApplication(participant, null), participant);
});

test('agent gaps become choice questions from grouped controls or a field option list', () => {
  const grouped = scanAnalysis.gapFromAgent([
    { fieldKey: 'pet:1', groupKey: 'pets', type: 'radio', label: 'Pets', optionLabel: 'Cat', optionValue: 'cat', required: true },
    { fieldKey: 'pet:2', groupKey: 'pets', type: 'radio', label: 'Pets', optionLabel: 'Dog', optionValue: 'dog' },
    { fieldKey: 'unrelated', type: 'text', label: 'Unrelated' },
  ], { fieldKey: 'pets', reason: 'No pet data in the record.' });
  assert.equal(grouped.kind, 'decision');
  assert.equal(grouped.inputType, 'choice');
  assert.deepEqual(grouped.options, [{ value: 'cat', label: 'Cat' }, { value: 'dog', label: 'Dog' }]);
  assert.equal(grouped.question, 'What should I enter for pets?');
  assert.equal(grouped.required, true);
  assert.equal(grouped.agentReason, 'No pet data in the record.');

  const select = scanAnalysis.gapFromAgent([
    { fieldKey: 'county', type: 'select-one', label: 'County?', sensitive: true, options: [{ label: 'Riverside', value: 'riv' }, { optionValue: 'org', optionLabel: 'Orange' }] },
  ], { fieldKey: 'county' });
  assert.deepEqual(select.options, [{ value: 'riv', label: 'Riverside' }, { value: 'org', label: 'Orange' }]);
  assert.equal(select.question, 'County?', 'a label that is already a question is asked as written');
  assert.equal(select.sensitive, true);

  const text = scanAnalysis.gapFromAgent([], { fieldKey: 'missing', question: 'What is the case number?' });
  assert.equal(text.label, 'Required form question');
  assert.equal(text.question, 'What is the case number?');
  assert.equal(text.kind, 'required');
  assert.equal(text.inputType, 'text');
  assert.deepEqual(text.options, []);
});

test('agent plans reword matching engine gaps, keep multi-select wording, and append new gaps', () => {
  const engineAnalysis = {
    assignments: [{ fieldKey: 'first' }],
    gaps: [
      { fieldKey: 'income', label: 'Income', question: 'Engine income question', inputType: 'text' },
      { fieldKey: 'needs', label: 'Needs', question: 'Engine needs question', inputType: 'multi_choice', members: [{ fieldKey: 'needs:food' }] },
      { fieldKey: 'phone', label: 'Phone', question: 'Engine phone question', inputType: 'text' },
    ],
    observed: [],
    counts: { fields: 5, missing: 3 },
  };
  const calls = [];
  const engine = {
    buildAnalysis(fields, participant, options) {
      calls.push({ fields, participant, options });
      return structuredClone(engineAnalysis);
    },
  };
  const response = { fields: [{ fieldKey: 'extra', type: 'text', label: 'Extra detail' }] };
  const plan = {
    purposeOverrides: { first: 'firstName' },
    gaps: [
      { fieldKey: 'income', question: 'What is the monthly income?', reason: 'Not in record' },
      { fieldKey: 'needs:food', question: 'Agent needs question', reason: 'Grouped' },
      { fieldKey: 'extra', reason: 'Agent-only gap' },
    ],
  };
  const analysis = scanAnalysis.analysisFromAgentPlan(engine, response, { id: 'p' }, plan);

  assert.deepEqual(calls[0].options, { purposeOverrides: { first: 'firstName' }, requirePurposeOverrides: true });
  assert.equal(calls[0].fields, response.fields);
  assert.deepEqual(analysis.gaps.map((gap) => gap.fieldKey), ['income', 'needs', 'phone', 'extra']);
  assert.equal(analysis.gaps[0].question, 'What is the monthly income?');
  assert.equal(analysis.gaps[0].agentReason, 'Not in record');
  assert.equal(analysis.gaps[1].question, 'Engine needs question', 'multi-select questions keep the engine wording');
  assert.equal(analysis.gaps[1].agentReason, 'Grouped');
  assert.equal(analysis.gaps[2].agentReason, undefined, 'an engine gap without a suggestion is unchanged');
  assert.equal(analysis.gaps[3].label, 'Extra detail');
  assert.equal(analysis.gaps[3].agentReason, 'Agent-only gap');
  assert.deepEqual(analysis.counts, { fields: 5, missing: 4 });
  assert.deepEqual(analysis.assignments, [{ fieldKey: 'first' }]);
});

test('scan status distinguishes no form, open questions, and ready to fill', () => {
  assert.equal(scanAnalysis.scannedStatus({ counts: { fields: 0 }, gaps: [] }, false), 'no_form');
  assert.equal(scanAnalysis.scannedStatus({ counts: { fields: 0 }, gaps: [] }, true), 'ready_to_fill');
  assert.equal(scanAnalysis.scannedStatus({ counts: { fields: 2 }, gaps: [{}] }, false), 'needs_attention');
  assert.equal(scanAnalysis.scannedStatus({ gaps: [] }, false), 'no_form');
});

test('a scanned application keeps its approved scope, requested name, and progress when asked', () => {
  const previous = {
    id: 'workflow:1',
    requestedName: 'CalFresh',
    allowedOrigins: ['https://benefitscal.com'],
    allowedPathPrefixes: ['/ApplyForBenefits/'],
    blocked: [{ label: 'SSN' }],
    empty: [{ label: 'Income' }],
    completedPages: [{ signature: 'a' }],
    visitedSignatures: ['a'],
    autoRun: 1,
    provenance: [{ fieldKey: 'f1', label: 'First', value: 'Celeste', source: 'record' }],
  };
  const response = {
    page: { url: 'https://benefitscal.com/ApplyForBenefits/step-2?b=2&a=1', title: 'Step 2' },
    playbook: { name: 'California benefits application' },
    navigationGate: { kind: 'next', pageSignature: 'sig-2' },
    submitGate: { found: false },
    tools: ['inspect_application_page'],
  };
  const analysis = { counts: { fields: 3 }, gaps: [], observed: [] };
  const checkpoint = { kind: 'final_review' };
  const kept = record.scannedApplication({
    previous,
    id: 'workflow:1',
    tab: { id: 9, url: 'https://benefitscal.com/ApplyForBenefits/step-2' },
    response,
    observedUrl: response.page.url,
    analysis,
    agentic: { runtime: 'chrome-local' },
    checkpoint,
    preservePageProgress: true,
  });

  assert.equal(kept.name, 'CalFresh');
  assert.equal(kept.queueLabel, 'CalFresh');
  assert.equal(kept.tabId, 9);
  assert.equal(kept.url, response.page.url);
  assert.equal(kept.status, 'ready_to_fill');
  assert.equal(kept.error, '');
  assert.equal(kept.checkpoint, checkpoint);
  assert.deepEqual(kept.allowedOrigins, ['https://benefitscal.com']);
  assert.deepEqual(kept.allowedPathPrefixes, ['/ApplyForBenefits/']);
  assert.deepEqual(kept.blocked, [{ label: 'SSN' }]);
  assert.deepEqual(kept.empty, [{ label: 'Income' }]);
  assert.equal(kept.provenance.length, 1);
  assert.equal(kept.autoRun, true);
  assert.deepEqual(kept.pageTools, ['inspect_application_page']);
  assert.equal(kept.resumePoint.location, response.page.url);
  assert.equal(kept.resumePoint.pageSignature, 'sig-2');
  assert.equal(kept.resumePoint.pageSignatureHash, workQueueEngine.signatureHash('sig-2'));
  assert.equal(
    kept.resumePoint.commandLocationHash,
    workQueueEngine.signatureHash('https://benefitscal.com/ApplyForBenefits/step-2?a=1&b=2'),
  );

  const fresh = record.scannedApplication({
    previous: {},
    id: 'workflow:2',
    tab: { id: 4, url: 'https://forms.example.org/apply/start' },
    response: { navigationGate: { kind: 'none' } },
    observedUrl: 'https://forms.example.org/apply/start',
    analysis: { counts: { fields: 0 }, gaps: [], observed: [] },
    agentic: null,
    checkpoint: null,
    preservePageProgress: false,
  });
  assert.equal(fresh.name, 'forms.example.org');
  assert.equal(fresh.status, 'no_form');
  assert.match(fresh.error, /No visible application fields/);
  assert.deepEqual(fresh.allowedOrigins, ['https://forms.example.org']);
  assert.deepEqual(fresh.allowedPathPrefixes, ['/apply/start']);
  assert.deepEqual(fresh.blocked, []);
  assert.deepEqual(fresh.completedPages, []);
  assert.equal(fresh.resumePoint.pageSignatureHash, '');
});

test('scan_completed audit details copy only the model usage the planner reported', () => {
  const analysis = { counts: { fields: 4 }, gaps: [{}, {}] };
  const full = scanAnalysis.scanAuditDetails({
    analysis,
    agentic: { runtime: 'local-cli' },
    usage: {
      prompts: 3,
      durationMs: 1200,
      inputCharacters: 900,
      outputCharacters: 300,
      contextUsageUnits: 7,
      inputTokens: 120,
      outputTokens: 0,
      apiCostUsd: 0.0123,
      providerReportedCostUsd: 0.5,
    },
    checkpointKind: 'human_input',
    status: 'needs_attention',
  });
  assert.deepEqual(full, {
    fieldCount: 4,
    gapCount: 2,
    modelRuntime: 'local-cli',
    modelPromptCount: 3,
    modelDurationMs: 1200,
    modelInputCharacters: 900,
    modelOutputCharacters: 300,
    modelContextUsageUnits: 7,
    modelInputTokens: 120,
    modelOutputTokens: 0,
    modelApiCostMicros: 12300,
    modelProviderReportedCostMicros: 500000,
    checkpointKind: 'human_input',
    toStatus: 'needs_attention',
  });

  const preview = scanAnalysis.scanAuditDetails({
    analysis: { gaps: [] },
    agentic: null,
    usage: null,
    checkpointKind: undefined,
    status: 'ready_to_fill',
  });
  assert.deepEqual(Object.keys(preview), [
    'fieldCount', 'gapCount', 'modelRuntime', 'modelPromptCount', 'modelDurationMs',
    'modelInputCharacters', 'modelOutputCharacters', 'modelApiCostMicros', 'checkpointKind', 'toStatus',
  ]);
  assert.equal(preview.modelApiCostMicros, 0);
  assert.equal(preview.fieldCount, 0);

  const partial = scanAnalysis.scanAuditDetails({
    analysis,
    agentic: null,
    usage: { inputTokens: Number.NaN, outputTokens: '12', providerReportedCostUsd: Infinity },
    status: 'ready_to_fill',
  });
  assert.equal(Object.hasOwn(partial, 'modelInputTokens'), false);
  assert.equal(Object.hasOwn(partial, 'modelOutputTokens'), false);
  assert.equal(Object.hasOwn(partial, 'modelProviderReportedCostMicros'), false);
});
