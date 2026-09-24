const test = require('node:test');
const assert = require('node:assert/strict');

const queue = require('../shared/work-queue-engine.js');

const sample = {
  id: 'workflow:abc',
  name: 'Benefits application — Maria Santos',
  queueLabel: 'California benefits application',
  workflowId: 'benefitscal',
  programIds: ['calfresh', 'medical'],
  allowedOrigins: ['https://benefitscal.com'],
  allowedPathPrefixes: ['/ApplyForBenefits/'],
  url: 'https://benefitscal.com/ApplyForBenefits/step?record=123-45-6789#client',
  tabId: 42,
  status: 'needs_attention',
  completedPages: [{ provenance: [{ value: 'Maria' }] }],
  navigationGate: { pageSignature: 'secret-field-value|page-2' },
  checkpoint: { kind: 'human_input', label: 'Client answer needed' },
  owner: { assignedTo: 'Intake Team', state: 'active' },
  updatedAt: '2026-09-15T12:00:00.000Z',
};

test('durable queue strips participant values, URL queries, and raw page signatures', () => {
  const durable = queue.durableApplication(sample);
  const serialized = JSON.stringify(durable);
  assert.equal(durable.name, 'California benefits application');
  assert.equal(durable.location, 'https://benefitscal.com');
  assert.equal(durable.workflowId, 'benefitscal');
  assert.deepEqual(durable.programIds, ['calfresh', 'medical']);
  assert.deepEqual(durable.allowedOrigins, ['https://benefitscal.com']);
  assert.deepEqual(durable.allowedPathPrefixes, ['/ApplyForBenefits/']);
  assert.match(durable.resumePoint.locationHash, /^fnv1a32:/);
  assert.match(durable.resumePoint.pageSignatureHash, /^fnv1a32:/);
  assert.doesNotMatch(serialized, /123-45-6789|secret-field-value|Maria Santos|"provenance"/);
  assert.equal(durable.completedPages, 1);
});

test('durable queue preserves missing versus intentionally empty program metadata', () => {
  const missingPrograms = { ...sample };
  delete missingPrograms.programIds;
  const missingDurable = queue.durableApplication(missingPrograms);
  const emptyDurable = queue.durableApplication({ ...sample, programIds: [] });

  assert.equal(Object.prototype.hasOwnProperty.call(missingDurable, 'programIds'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(emptyDurable, 'programIds'), true);
  assert.deepEqual(emptyDurable.programIds, []);
});

test('legacy BenefitsCal queues with unknown programs pause for reselection', () => {
  const legacySaved = queue.durableApplication(sample);
  delete legacySaved.workflowId;
  delete legacySaved.programIds;
  const legacySession = { ...sample, status: 'ready_to_fill', autoRun: true, checkpoint: null };
  const restored = queue.restoreApplications({ version: 1, applications: [legacySaved] }, [legacySession]);

  assert.equal(restored[0].status, 'paused');
  assert.equal(restored[0].autoRun, false);
  assert.equal(restored[0].programSelectionRequired, true);
  assert.equal(Object.prototype.hasOwnProperty.call(restored[0], 'programIds'), false);
  assert.equal(restored[0].checkpoint.kind, 'human_input');
  assert.match(restored[0].error, /BenefitsCal programs/);
});

test('explicitly empty BenefitsCal selection remains known during restore', () => {
  const durable = queue.buildQueue([{ ...sample, programIds: [] }]);
  const restored = queue.restoreApplications(durable, [{ ...sample, programIds: ['calfresh'], autoRun: true }]);

  assert.deepEqual(restored[0].programIds, []);
  assert.equal(restored[0].programSelectionRequired, undefined);
  assert.equal(restored[0].status, sample.status);
});

test('restart recovery preserves queue metadata but marks source data expired', () => {
  const durable = queue.buildQueue([sample]);
  assert.equal(durable.version, 2);
  const restored = queue.restoreApplications(durable, []);
  assert.equal(restored.length, 1);
  assert.equal(restored[0].status, 'source_expired');
  assert.equal(restored[0].checkpoint.kind, 'source_expired');
  assert.equal(restored[0].durableOnly, true);
});

test('durable tab-closure state overrides stale session tab state', () => {
  const durable = queue.markTabClosed(queue.buildQueue([sample]), 42, { at: '2026-09-15T13:00:00.000Z', id: 'event-closed' });
  const restored = queue.restoreApplications(durable, [{ ...sample, status: 'ready_to_fill', checkpoint: null }]);
  assert.equal(restored[0].tabId, null);
  assert.equal(restored[0].status, 'paused');
  assert.equal(restored[0].checkpoint.kind, 'tab_closed');
});

test('resume requires source data, the same sanitized location, and the same page signature', () => {
  const application = {
    ...sample,
    resumePoint: {
      location: queue.safeLocation(sample.url),
      locationHash: queue.signatureHash(queue.safeLocation(sample.url)),
      pageSignatureHash: queue.signatureHash('page-2'),
    },
  };
  assert.equal(queue.resumeDecision(application, { url: sample.url, pageSignature: 'page-2' }, { sourceAvailable: false }).outcome, 'source_expired');
  assert.equal(queue.resumeDecision(application, { url: 'https://benefitscal.com/other', pageSignature: 'page-2' }, { sourceAvailable: true }).outcome, 'location_changed');
  assert.equal(queue.resumeDecision(application, { url: sample.url, pageSignature: 'page-3' }, { sourceAvailable: true }).outcome, 'page_changed');
  assert.equal(queue.resumeDecision(application, { url: sample.url, pageSignature: 'page-2' }, { sourceAvailable: true }).allowed, true);
});

test('resume rejects stale connector data and an unaccepted handoff', () => {
  assert.equal(queue.resumeDecision(sample, { url: sample.url }, { sourceAvailable: true, sourceStale: true }).outcome, 'source_stale');
  const handedOff = { ...sample, handoff: { to: 'Eligibility Team', reason: 'client_question', createdAt: new Date().toISOString() } };
  assert.equal(queue.resumeDecision(handedOff, { url: sample.url }, { sourceAvailable: true }).outcome, 'handoff_pending');
});

test('active leases stop a second assistant window and expired leases can be reclaimed', () => {
  const first = queue.acquireLease(sample, 'window-a', { now: 10000, leaseMs: 60000 });
  assert.equal(first.allowed, true);
  const second = queue.acquireLease({ ...sample, lease: first.lease }, 'window-b', { now: 20000, leaseMs: 60000 });
  assert.equal(second.allowed, false);
  const reclaimed = queue.acquireLease({ ...sample, lease: first.lease }, 'window-b', { now: 80000, leaseMs: 60000 });
  assert.equal(reclaimed.allowed, true);
});

test('tab closure creates a durable checkpoint and value-free audit event', () => {
  const durable = queue.buildQueue([sample]);
  const updated = queue.markTabClosed(durable, 42, { at: '2026-09-15T13:00:00.000Z', id: 'event-1' });
  assert.equal(updated.applications[0].tabId, null);
  assert.equal(updated.applications[0].status, 'paused');
  assert.equal(updated.applications[0].checkpoint.kind, 'tab_closed');
  assert.equal(updated.audit.at(-1).type, 'tab_closed');
  assert.doesNotMatch(JSON.stringify(updated.audit), /Maria|123-45-6789|secret-field-value/);
});

test('audit export allowlists event details and contains no participant payload', () => {
  const event = queue.auditEvent('page_verified', sample, {
    verifiedCount: 4,
    modelRuntime: 'chrome-gemini-nano',
    modelPromptCount: 3,
    modelDurationMs: 1250,
    modelApiCostMicros: 0,
    participantValue: 'Maria',
    rawUrl: sample.url,
    checkpointKind: 'human_input',
  }, { at: '2026-09-15T13:00:00.000Z', id: 'event-2' });
  const durable = queue.buildQueue([sample], [event]);
  const exported = queue.exportAudit(durable, { at: '2026-09-15T14:00:00.000Z' });
  const serialized = JSON.stringify(exported);
  assert.equal(exported.schema, 'nava.form-filling.audit.v1');
  assert.equal(exported.events[0].details.verifiedCount, 4);
  assert.equal(exported.events[0].details.modelRuntime, 'chrome-gemini-nano');
  assert.equal(exported.events[0].details.modelPromptCount, 3);
  assert.equal(exported.events[0].details.modelDurationMs, 1250);
  assert.equal(exported.events[0].details.modelApiCostMicros, 0);
  assert.equal(exported.events[0].details.participantValue, undefined);
  assert.doesNotMatch(serialized, /Maria|123-45-6789|secret-field-value|record=/);
});

test('completed human checkpoints produce a PII-free audit event', () => {
  const event = queue.auditEvent('checkpoint_completed', sample, {
    checkpointKind: 'captcha',
    participantValue: 'secret-field-value',
  }, { at: '2026-09-15T13:30:00.000Z', id: 'event-captcha-complete' });

  assert.equal(event.type, 'checkpoint_completed');
  assert.equal(event.details.checkpointKind, 'captcha');
  assert.equal(event.details.participantValue, undefined);
});
