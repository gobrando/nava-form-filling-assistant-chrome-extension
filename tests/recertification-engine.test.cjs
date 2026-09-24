const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const engine = require('../shared/recertification-engine.js');

const root = path.resolve(__dirname, '..');

const today = new Date('2026-09-24T15:00:00Z');

function caseFixture(overrides = {}) {
  return {
    id: 'recert-1',
    recordId: 'record-1',
    displayName: 'Fictional Client',
    firstName: 'Fictional',
    programId: 'calfresh',
    programName: 'CalFresh',
    dueDate: '2026-10-06',
    preferredContact: 'Email',
    requirements: {
      contact: { status: 'current' },
      household: { status: 'missing' },
      income: { status: 'stale' },
      expenses: { status: 'confirmed' },
      documents: { status: 'current' },
    },
    ...overrides,
  };
}

test('classifies explicit due dates without inferring a renewal date', () => {
  const item = engine.normalizeCase(caseFixture(), { today });
  assert.equal(item.daysUntilDue, 12);
  assert.equal(item.urgency.key, 'urgent');
  assert.equal(item.openRequirements.length, 2);
  assert.equal(item.readyToPrepare, false);
  assert.equal(engine.normalizeCaseload([{ ...caseFixture(), dueDate: '' }], { today }).length, 0);
});

test('requires complete information and explicit authorization before AI preparation', () => {
  const complete = Object.fromEntries(engine.REQUIREMENTS.map((requirement) => [requirement.key, { status: 'confirmed' }]));
  const invited = engine.normalizeCase(caseFixture({ requirements: complete, consent: { status: 'invited' } }), { today });
  const authorized = engine.normalizeCase(caseFixture({ requirements: complete, consent: { status: 'authorized' } }), { today });
  assert.equal(invited.readyToPrepare, false);
  assert.equal(authorized.readyToPrepare, true);
  assert.equal(authorized.consent.scope, 'prepare_through_review');
});

test('builds separate caseworker and client notices with the no-submit boundary', () => {
  const item = engine.normalizeCase(caseFixture(), { today });
  const plan = engine.notificationPlan(item);
  assert.match(plan.caseworker.body, /Fictional Client/);
  assert.match(plan.client.body, /Would you like the AI assistant/);
  assert.match(plan.client.body, /review, certify, sign, and submit/);
  assert.match(plan.client.body, /Household changes/);
});

test('session workspace updates readiness without mutating source data', () => {
  const source = engine.normalizeCase(caseFixture(), { today });
  const requirements = Object.fromEntries(engine.REQUIREMENTS.map((requirement) => [requirement.key, { status: 'confirmed', note: 'Reviewed with client.' }]));
  const merged = engine.mergeWorkspace(source, {
    requirements,
    consent: { status: 'authorized', recordedAt: '2026-09-24T16:00:00Z' },
    outreach: { status: 'completed', channel: 'Email', completedAt: '2026-09-24T15:30:00Z' },
  });
  assert.equal(source.readyToPrepare, false);
  assert.equal(merged.readyToPrepare, true);
  assert.equal(merged.outreach.status, 'completed');
});

test('summarizes a caseload by operational state', () => {
  const complete = Object.fromEntries(engine.REQUIREMENTS.map((requirement) => [requirement.key, { status: 'current' }]));
  const cases = engine.normalizeCaseload([
    caseFixture(),
    caseFixture({ id: 'recert-2', recordId: 'record-2', dueDate: '2026-10-20', requirements: complete, consent: { status: 'authorized' } }),
  ], { today });
  assert.deepEqual(engine.summarize(cases), {
    total: 2,
    dueWithin45Days: 2,
    needsData: 1,
    awaitingAuthorization: 0,
    ready: 1,
  });
});

test('extension wiring keeps answers session-only and locks preparation behind readiness', () => {
  const panel = fs.readFileSync(path.join(root, 'sidepanel/sidepanel.js'), 'utf8');
  const background = fs.readFileSync(path.join(root, 'background.js'), 'utf8');
  const html = fs.readFileSync(path.join(root, 'sidepanel/index.html'), 'utf8');
  const saveStart = panel.indexOf('async function saveRecertificationWorkspace');
  const saveEnd = panel.indexOf('async function loadRecertifications', saveStart);
  const prepareStart = panel.indexOf('async function prepareRecertification');
  const prepareEnd = panel.indexOf('async function onClick', prepareStart);
  const save = panel.slice(saveStart, saveEnd);
  const prepare = panel.slice(prepareStart, prepareEnd);

  assert.match(html, /shared\/recertification-engine\.js/);
  assert.match(background, /LIST_RECERTIFICATIONS/);
  assert.match(background, /connectorRequest\(saved\.config, 'recertifications'/);
  assert.match(save, /chrome\.storage\.session\.set/);
  assert.doesNotMatch(save, /chrome\.storage\.local/);
  assert.match(prepare, /if \(!item\.readyToPrepare\)/);
  assert.match(prepare, /type: 'LOOKUP_RECORD'/);
  assert.match(prepare, /openSelectedPrograms\(\[item\.programId\]\)/);
  assert.doesNotMatch(prepare, /NAVA_SUBMIT|requestSubmit|\.submit\(/);
  assert.match(panel, /Client messages remain drafts until an authorized worker sends them/);
});
