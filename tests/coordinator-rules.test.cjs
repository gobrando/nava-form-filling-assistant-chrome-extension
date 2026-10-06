const test = require('node:test');
const assert = require('node:assert/strict');

const rules = require('../background/coordinator-rules.js');

const APP = 'workflow:test';

function coordinator(overrides = {}) {
  return rules.normalizeCoordinator({
    sessionEpoch: 3,
    stateRevision: 7,
    participantSessionId: 'participant:alice',
    applicationGenerations: { [APP]: 2 },
    applicationRevisions: { [APP]: 5 },
    updatedAt: '2026-09-17T12:00:00.000Z',
    ...overrides,
  });
}

function inMinutes(minutes, now = Date.now()) {
  return new Date(now + minutes * 60 * 1000).toISOString();
}

test('coordinator ids are short, start alphanumeric, and use only id punctuation', () => {
  assert.equal(rules.validCoordinatorId('workflow:benefitscal.calfresh_1-a'), 'workflow:benefitscal.calfresh_1-a');
  assert.equal(rules.validCoordinatorId(`a${'b'.repeat(119)}`).length, 120);
  ['', null, '../workflow', ':workflow', 'workflow test', `a${'b'.repeat(120)}`].forEach((value) => {
    assert.throws(() => rules.validCoordinatorId(value), /Invalid application coordination identifier/, String(value));
  });
});

test('normalizing persisted coordinator state keeps valid counters and drops malformed metadata', () => {
  assert.deepEqual(rules.normalizeCoordinator({
    sessionEpoch: 0,
    stateRevision: -4,
    participantSessionId: '../not-an-id',
    applicationGenerations: { [APP]: 2, '../bad': 4, 'workflow:negative': -1, 'workflow:fraction': 1.5 },
    applicationRevisions: { [APP]: '3' },
    updatedAt: '2026-09-17T12:00:00.000Z',
  }), {
    sessionEpoch: 1,
    applicationGenerations: { [APP]: 2, 'workflow:negative': 0, 'workflow:fraction': 0 },
    applicationRevisions: { [APP]: 3 },
    participantSessionId: '',
    stateRevision: 1,
    updatedAt: '2026-09-17T12:00:00.000Z',
  });

  const empty = rules.normalizeCoordinator(undefined);
  assert.equal(empty.sessionEpoch, 1);
  assert.equal(empty.stateRevision, 1);
  assert.equal(empty.participantSessionId, '');
  assert.deepEqual(empty.applicationGenerations, {});
  assert.ok(Number.isFinite(Date.parse(empty.updatedAt)));

  const many = Object.fromEntries(Array.from({ length: 150 }, (_, index) => [`workflow:${index}`, index]));
  assert.equal(Object.keys(rules.normalizeCoordinator({ applicationGenerations: many }).applicationGenerations).length, 100);
});

test('coordinator fields are a detached copy of the counters a window must echo back', () => {
  const current = coordinator();
  const fields = rules.coordinatorFields(current);
  assert.deepEqual(fields, {
    sessionEpoch: 3,
    participantSessionId: 'participant:alice',
    stateRevision: 7,
    applicationGenerations: { [APP]: 2 },
    applicationRevisions: { [APP]: 5 },
  });
  fields.applicationGenerations[APP] = 99;
  assert.equal(current.applicationGenerations[APP], 2);

  const participantSessionId = rules.newParticipantSessionId();
  assert.match(participantSessionId, /^participant:/);
  assert.equal(rules.validCoordinatorId(participantSessionId), participantSessionId);
});

test('participant records must be one object and are stored as a copy', () => {
  const participant = { firstName: 'Fictional', household: [{ name: 'Child' }] };
  const stored = rules.participantValue(participant);
  assert.deepEqual(stored, participant);
  assert.notEqual(stored.household, participant.household);
  [null, undefined, 'Fictional', [participant]].forEach((value) => {
    assert.throws(() => rules.participantValue(value), /one participant record object/);
  });
});

test('application comparison ignores run-control fields and unserializable values never compare equal', () => {
  const stored = { id: APP, status: 'ready_to_fill', controlGeneration: 1, controlRevision: 1, lease: { holder: 'a' } };
  assert.equal(rules.applicationChanged(stored, { ...stored, controlGeneration: 2, controlRevision: 9, lease: null }), false);
  assert.equal(rules.applicationChanged(stored, { ...stored, status: 'paused' }), true);
  assert.equal(rules.applicationChanged(null, stored), true);
  assert.equal(rules.applicationChanged(null, null), false);
  assert.equal(rules.sameValue({ a: 1 }, { a: 1 }), true);
  assert.equal(rules.sameValue({ a: 1n }, { a: 1n }), false);
});

test('merge rules replace only changed applications and keep one audit event per id in time order', () => {
  const current = [{ id: 'a', version: 1 }, { id: 'b', version: 1 }];
  const incoming = [{ id: 'a', version: 2 }, { id: 'b', version: 2 }, { id: 'c', version: 1 }];
  assert.deepEqual(rules.replaceApplications(current, incoming, new Set(['b', 'c'])), [
    { id: 'a', version: 1 },
    { id: 'b', version: 2 },
    { id: 'c', version: 1 },
  ]);
  assert.deepEqual(rules.replaceApplications(undefined, 'not a list', new Set(['a'])), []);

  const merged = rules.mergeAudit(
    [{ id: 'late', at: '2026-01-03T00:00:00.000Z' }, { id: 'edited', at: '2026-01-02T00:00:00.000Z', note: 'old' }],
    [{ id: 'edited', at: '2026-01-01T00:00:00.000Z', note: 'new' }, { at: '2026-01-04T00:00:00.000Z' }],
  );
  assert.deepEqual(merged, [
    { id: 'edited', at: '2026-01-01T00:00:00.000Z', note: 'new' },
    { id: 'late', at: '2026-01-03T00:00:00.000Z' },
  ]);

  assert.deepEqual([...rules.applicationsById([{ id: 'a' }, { name: 'no id' }, null]).keys()], ['a']);
  assert.equal(rules.applicationsById('not a list').size, 0);
  assert.deepEqual(rules.storedApplicationIds([{ id: 'b' }, { id: 'a' }], [{ id: 'a' }, { id: 'c' }, {}]), ['b', 'a', 'c']);
  assert.deepEqual(rules.storedApplicationIds(undefined, undefined), []);
});

test('a revoked application stops automatic runs, drops its lease, and records why', () => {
  const updatedAt = '2026-09-17T12:00:00.000Z';
  const paused = rules.revokedApplication({ id: APP, status: 'filling', autoRun: true, lease: { holder: 'a' } }, { updatedAt });
  assert.deepEqual(paused, {
    id: APP,
    status: 'paused',
    autoRun: false,
    lease: null,
    error: '',
    runStopReason: 'Paused by caseworker',
    checkpoint: { kind: 'voluntary_pause', label: 'Paused by caseworker', createdAt: updatedAt },
    updatedAt,
  });
  const expired = rules.revokedApplication({ id: APP }, {
    status: 'source_expired',
    checkpointKind: 'source_expired',
    checkpointLabel: 'Reload client data after connector change',
    updatedAt,
  });
  assert.equal(expired.error, 'The connected data source changed. Reload the client before resuming.');
  assert.equal(rules.revokedApplication(null, { updatedAt }), null);

  const current = coordinator();
  rules.invalidateApplicationRun(current, APP);
  rules.invalidateApplicationRun(current, 'workflow:new');
  assert.deepEqual(current.applicationGenerations, { [APP]: 3, 'workflow:new': 1 });
  assert.deepEqual(current.applicationRevisions, { [APP]: 6, 'workflow:new': 1 });
});

test('epoch, state revision, and participant assertions reject windows from another session or snapshot', () => {
  const current = coordinator();
  rules.assertCoordinatorEpoch({ sessionEpoch: 3 }, current);
  assert.throws(() => rules.assertCoordinatorEpoch({ sessionEpoch: 2 }, current), {
    code: 'STALE_SESSION_EPOCH',
    coordinator: rules.coordinatorFields(current),
  });

  assert.equal(rules.assertStateRevision({ stateRevision: 7 }, current), 7);
  assert.throws(() => rules.assertStateRevision({ stateRevision: 6 }, current), { code: 'STALE_STATE_REVISION' });

  assert.equal(rules.assertParticipantSession({ participantSessionId: 'participant:alice' }, current), 'participant:alice');
  assert.throws(
    () => rules.assertParticipantSession({ participantSessionId: 'participant:bob' }, current),
    { code: 'PARTICIPANT_SESSION_MISMATCH' },
  );
  const unclaimed = coordinator({ participantSessionId: '' });
  assert.throws(() => rules.assertParticipantSession({}, unclaimed), { code: 'CLIENT_SESSION_REQUIRED' });
  assert.equal(rules.assertParticipantSession({}, unclaimed, { required: false }), '');
});

test('generation and revision assertions prefer per-application counters and name the stale application', () => {
  const current = coordinator();
  assert.equal(rules.assertApplicationGeneration({ applicationGeneration: 2 }, current, APP), 2);
  assert.equal(
    rules.assertApplicationGeneration({ applicationGenerations: { [APP]: 2 }, applicationGeneration: 9 }, current, APP),
    2,
  );
  assert.throws(
    () => rules.assertApplicationGeneration({ applicationGenerations: { [APP]: 1 } }, current, APP),
    { code: 'STALE_APPLICATION_GENERATION', applicationId: APP },
  );
  assert.equal(rules.assertApplicationGeneration({}, current, 'workflow:new'), 0);

  assert.equal(rules.assertApplicationRevision({ applicationRevisions: { [APP]: 5 } }, current, APP), 5);
  assert.throws(
    () => rules.assertApplicationRevision({ applicationRevision: 4 }, current, APP),
    { code: 'STALE_APPLICATION_REVISION', applicationId: APP, applicationRevision: 5 },
  );

  const run = { sessionEpoch: 3, participantSessionId: 'participant:alice', applicationGeneration: 2, applicationRevision: 5 };
  assert.deepEqual(rules.assertCurrentApplicationRun(run, current, APP), { applicationGeneration: 2, applicationRevision: 5 });
  assert.throws(() => rules.assertCurrentApplicationRun({ ...run, sessionEpoch: 4 }, current, APP), { code: 'STALE_SESSION_EPOCH' });
  assert.throws(
    () => rules.assertCurrentApplicationRun({ ...run, participantSessionId: 'participant:bob' }, current, APP),
    { code: 'PARTICIPANT_SESSION_MISMATCH' },
  );
});

test('lease assertions accept only a live lease held by the caller and ignore expired foreign leases', () => {
  const current = coordinator();
  const now = Date.now();
  const live = { holder: 'window-a', expiresAt: inMinutes(2, now) };
  const expired = { holder: 'window-b', expiresAt: inMinutes(-1, now) };
  assert.equal(rules.activeLease(live, now), true);
  assert.equal(rules.activeLease(expired, now), false);
  assert.equal(rules.activeLease({ expiresAt: inMinutes(2, now) }, now), false);
  assert.equal(rules.activeLease({ holder: 'window-a', expiresAt: 'not a date' }, now), false);
  assert.equal(rules.activeLease(null, now), false);

  assert.equal(rules.assertActiveLeaseHolder(live, 'window-a', current, APP), live);
  assert.throws(() => rules.assertActiveLeaseHolder(live, 'window-b', current, APP), { code: 'LEASE_LOST', applicationId: APP });
  assert.throws(() => rules.assertActiveLeaseHolder(expired, 'window-b', current, APP), { code: 'LEASE_LOST' });

  rules.assertLeaseNotHeldByOther(live, 'window-a', current, APP);
  rules.assertLeaseNotHeldByOther(expired, 'window-a', current, APP);
  rules.assertLeaseNotHeldByOther(undefined, 'window-a', current, APP);
  assert.throws(() => rules.assertLeaseNotHeldByOther(live, 'window-b', current, APP), { code: 'LEASE_HELD', applicationId: APP });
});

test('coordination errors become responses that flag stale windows and carry the current counters', () => {
  const current = coordinator();
  let thrown;
  try {
    rules.assertApplicationRevision({ applicationRevision: 1 }, current, APP);
  } catch (error) {
    thrown = error;
  }
  assert.deepEqual(rules.coordinationError(thrown, { dispatched: false }), {
    ok: false,
    stale: true,
    code: 'STALE_APPLICATION_REVISION',
    error: 'This application changed in another assistant window. Reload it before saving or continuing.',
    ...rules.coordinatorFields(current),
    applicationId: APP,
    applicationRevision: 5,
    dispatched: false,
  });

  [
    'STALE_SESSION_EPOCH',
    'STALE_STATE_REVISION',
    'STALE_APPLICATION_GENERATION',
    'STALE_APPLICATION_REVISION',
    'PARTICIPANT_SESSION_MISMATCH',
    'CLIENT_SESSION_CLAIMED',
    'CLIENT_SESSION_REQUIRED',
    'LEASE_LOST',
    'LEASE_HELD',
    'APPLICATION_TAB_MISMATCH',
  ].forEach((code) => {
    assert.equal(rules.coordinationError(rules.coordinatorError('stale', code, current)).stale, true, code);
  });

  assert.deepEqual(rules.coordinationError(new Error('Invalid application coordination identifier.'), { allowed: false }), {
    ok: false,
    stale: false,
    code: 'COORDINATOR_ERROR',
    error: 'Invalid application coordination identifier.',
    allowed: false,
  });
  assert.equal(rules.coordinationError(undefined).error, 'The assistant coordinator rejected the operation.');
});
