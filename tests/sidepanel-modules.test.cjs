// Side-panel coordination modules created on their own over recording stubs: run control, coordinator sync and
// writes, the planner runtime, automatic runs, the recertification caseload, connector actions, and UI dispatch.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const workQueueEngine = require('../shared/work-queue-engine.js');
const connectorEngine = require('../shared/connector-engine.js');
const { sidePanelScripts, sidePanelSource } = require('./runtime-sources.cjs');
const runControlModule = require('../sidepanel/run-control.js');
const coordinatorMergeModule = require('../sidepanel/coordinator-merge.js');
const coordinatorSyncModule = require('../sidepanel/coordinator-sync.js');
const coordinatorWritesModule = require('../sidepanel/coordinator-writes.js');
const agentRuntimeModule = require('../sidepanel/agent-runtime.js');
const automaticRunsModule = require('../sidepanel/automatic-runs.js');
const recertificationCaseloadModule = require('../sidepanel/recertification-caseload.js');
const agentActionsModule = require('../sidepanel/actions-agent.js');
const recertificationActionsModule = require('../sidepanel/actions-recertification.js');
const intakeActionsModule = require('../sidepanel/actions-intake.js');
const connectorActionsModule = require('../sidepanel/actions-connector.js');
const applicationActionsModule = require('../sidepanel/actions-applications.js');
const uiDispatchModule = require('../sidepanel/ui-dispatch.js');

const MODULES = {
  'sidepanel/run-control.js': runControlModule,
  'sidepanel/coordinator-merge.js': coordinatorMergeModule,
  'sidepanel/coordinator-sync.js': coordinatorSyncModule,
  'sidepanel/coordinator-writes.js': coordinatorWritesModule,
  'sidepanel/agent-runtime.js': agentRuntimeModule,
  'sidepanel/automatic-runs.js': automaticRunsModule,
  'sidepanel/recertification-caseload.js': recertificationCaseloadModule,
  'sidepanel/actions-agent.js': agentActionsModule,
  'sidepanel/actions-recertification.js': recertificationActionsModule,
  'sidepanel/actions-intake.js': intakeActionsModule,
  'sidepanel/actions-connector.js': connectorActionsModule,
  'sidepanel/actions-applications.js': applicationActionsModule,
  'sidepanel/ui-dispatch.js': uiDispatchModule,
};

const tick = () => new Promise((resolve) => setImmediate(resolve));
const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

/** A chrome stand-in that records tab messages and storage writes per area. */
function fakeChrome() {
  const calls = [];
  const area = (name) => ({
    async get(key) {
      calls.push([`storage.${name}.get`, key]);
      return {};
    },
    async set(value) {
      calls.push([`storage.${name}.set`, value]);
    },
  });
  return {
    calls,
    tabs: {
      async sendMessage(tabId, message) {
        calls.push(['tabs.sendMessage', tabId, message]);
      },
    },
    storage: { session: area('session'), local: area('local') },
  };
}

function runControl({ state, previewMode = false, onCancelAll = () => {}, revokeApplicationRun = async () => {} }) {
  return runControlModule.create({
    state,
    previewMode,
    checkpoint: (kind, label) => ({ kind, label }),
    revokeApplicationRun,
    onCancelAll,
  });
}

test('every new side-panel module exports create(), loads before the composition root, and reads no Nava globals', () => {
  const scripts = sidePanelScripts();
  const rootIndex = scripts.indexOf('sidepanel/sidepanel.js');
  assert.ok(rootIndex > 0);
  for (const [file, api] of Object.entries(MODULES)) {
    assert.equal(typeof api.create, 'function', file);
    const index = scripts.indexOf(file);
    assert.ok(index >= 0 && index < rootIndex, `${file} must load before sidepanel.js`);
    const source = fs.readFileSync(path.resolve(__dirname, '..', file), 'utf8');
    assert.doesNotMatch(source, /globalThis\.Nava/, `${file} must take its engines from the composition root`);
  }
  assert.ok(scripts.indexOf('sidepanel/recertification-caseload.js') < scripts.indexOf('sidepanel/ui-dispatch.js'));
  assert.ok(scripts.indexOf('sidepanel/actions-applications.js') < scripts.indexOf('sidepanel/ui-dispatch.js'));
});

test('the dispatcher outcome and screen switch are declared once, so every action table shares their identity', () => {
  const panel = sidePanelSource();
  assert.equal(panel.match(/const SKIP_FINAL_RENDER = /g).length, 1);
  assert.equal(panel.match(/function showScreen\(/g).length, 1);
  const first = uiDispatchModule.handlerContract({});
  const second = uiDispatchModule.handlerContract({});
  assert.equal(first.SKIP_FINAL_RENDER, second.SKIP_FINAL_RENDER);
  assert.ok(Object.isFrozen(first.SKIP_FINAL_RENDER));
  const state = { view: 'choice' };
  uiDispatchModule.handlerContract(state).showScreen('record')();
  assert.equal(state.view, 'record');
});

test('run control issues one token per application, replaces a live run only after it settles, and clears it on end', async () => {
  const application = { id: 'app-1', controlGeneration: 0 };
  const state = { apps: [application], sessionEpoch: 1, workerId: 'worker-1' };
  const control = runControl({ state });

  const first = await control.beginApplicationRun(application);
  assert.equal(control.isRunning('app-1'), true);
  assert.equal(control.activeRun('app-1'), first);
  assert.equal(control.activeRunCount(), 1);
  assert.doesNotThrow(() => control.assertApplicationRun(application, first));
  application.controlGeneration = 1;
  assert.throws(() => control.assertApplicationRun(application, first), { name: 'RunCancelledError' });
  application.controlGeneration = 0;

  const replacement = control.beginApplicationRun(application);
  assert.equal(first.cancelled, true, 'a new run cancels the live one');
  assert.equal(control.activeRun('app-1'), first, 'and waits for it to settle');
  control.endApplicationRun(application, first);
  const second = await replacement;
  assert.notEqual(second, first);
  assert.equal(control.activeRun('app-1'), second);
  control.endApplicationRun(application, second);
  assert.equal(control.isRunning('app-1'), false);
  assert.equal(control.activeRunCount(), 0);

  assert.equal(await control.withNewApplicationRun(application, async (token) => token.uiBound), false);
  assert.equal(control.activeRunCount(), 0, 'withNewApplicationRun ends its run');
  await assert.rejects(control.beginApplicationRun({ id: 'gone' }), { name: 'RunCancelledError' });
});

test('cancelling every run bumps the session, cancels each run, then clears the automatic queue', async () => {
  const one = { id: 'one' };
  const two = { id: 'two' };
  const state = { apps: [one, two], sessionEpoch: 1, workerId: 'worker-1' };
  const tokens = {};
  const cancelledAtClear = [];
  const control = runControl({
    state,
    onCancelAll: () => cancelledAtClear.push(tokens.one.cancelled, tokens.two.cancelled),
  });
  tokens.one = await control.beginApplicationRun(one);
  tokens.two = await control.beginApplicationRun(two);
  const waitingReplacement = control.beginApplicationRun(one);

  control.cancelAllRuns();
  assert.deepEqual(cancelledAtClear, [true, true]);
  control.endApplicationRun(one, tokens.one);
  await assert.rejects(waitingReplacement, { name: 'RunCancelledError' }, 'a run requested before the cancel belongs to the old session');
  assert.throws(() => control.assertApplicationRun(two, tokens.two), { name: 'RunCancelledError' });

  control.endApplicationRun(two, tokens.two);
  const fresh = await control.beginApplicationRun(two);
  assert.doesNotThrow(() => control.assertApplicationRun(two, fresh));
});

test('NAVA_CANCEL goes to the tab only outside the preview and only when this window holds the lease', () => {
  const cases = [
    { previewMode: false, application: { id: 'a', tabId: 9, lease: { holder: 'worker-1' } }, sent: true },
    { previewMode: false, application: { id: 'a', tabId: 9, lease: { holder: 'other-window' } }, sent: false },
    { previewMode: false, application: { id: 'a', tabId: 9 }, sent: false },
    { previewMode: false, application: { id: 'a', lease: { holder: 'worker-1' } }, sent: false },
    { previewMode: true, application: { id: 'a', tabId: 9, lease: { holder: 'worker-1' } }, sent: false },
  ];
  for (const { previewMode, application, sent } of cases) {
    globalThis.chrome = fakeChrome();
    const control = runControl({ state: { apps: [application], sessionEpoch: 1, workerId: 'worker-1' }, previewMode });
    control.cancelApplicationRun(application);
    assert.deepEqual(globalThis.chrome.calls, sent ? [['tabs.sendMessage', 9, { type: 'NAVA_CANCEL' }]] : [], JSON.stringify(application));
  }
  delete globalThis.chrome;
});

test('a UI-bound run requested under an older screen generation stops with UiCancelledError', async () => {
  const application = { id: 'app-1' };
  const control = runControl({ state: { apps: [application], sessionEpoch: 1, workerId: 'worker-1' } });
  const generation = control.currentUiGeneration();
  const previous = await control.beginApplicationRun(application);
  let ran = false;
  const uiRun = control.withNewApplicationRun(application, async () => { ran = true; }, { uiBound: true });

  assert.equal(control.cancelPendingUiWork(), generation + 1);
  assert.equal(control.currentUiGeneration(), generation + 1);
  control.endApplicationRun(application, previous);
  await assert.rejects(uiRun, { name: 'UiCancelledError' });
  assert.equal(ran, false);
  assert.equal(control.isRunning('app-1'), false);
  assert.throws(() => control.assertUiGeneration(generation), { name: 'UiCancelledError' });
  assert.doesNotThrow(() => control.assertUiGeneration(generation + 1));
});

test('returning home pauses only UI-bound runs, after revoking each one', async () => {
  const uiBound = { id: 'ui', autoRun: true, status: 'filling' };
  const automatic = { id: 'auto', autoRun: true, status: 'filling' };
  const revoked = [];
  const control = runControl({
    state: { apps: [uiBound, automatic], sessionEpoch: 1, workerId: 'worker-1' },
    revokeApplicationRun: async (application) => revoked.push(application.id),
  });
  const uiToken = await control.beginApplicationRun(uiBound, { uiBound: true });
  const automaticToken = await control.beginApplicationRun(automatic);
  await control.cancelUiBoundRuns();
  assert.deepEqual(revoked, ['ui']);
  assert.equal(uiToken.cancelled, true);
  assert.equal(automaticToken.cancelled, false);
  assert.equal(uiBound.status, 'paused');
  assert.equal(uiBound.autoRun, false);
  assert.deepEqual(uiBound.checkpoint, { kind: 'voluntary_pause', label: 'Paused when the assistant returned home' });
  assert.equal(automatic.status, 'filling');
});

/** Coordinator writes over a real run control and scripted service-worker responses; `events` records sends and sync calls in order. */
function coordinatorWrites({ responses, apps = [{ id: 'app-1' }], syncRunning = () => false }) {
  const state = {
    apps,
    audit: [],
    currentAppId: null,
    sessionEpoch: 4,
    participantSessionId: 'session-1',
    coordinatorRevision: 7,
    workerId: 'worker-1',
  };
  const events = [];
  const control = runControl({ state });
  const writes = coordinatorWritesModule.create({
    ...control,
    state,
    previewMode: false,
    workQueueEngine,
    async sendRuntime(message) {
      events.push(['send', message.type]);
      return responses.shift();
    },
    recordAudit: () => {},
    withCoordinatorMutation: (action) => action(),
    applyCoordinatorMetadata: (response) => events.push(['apply', response.stateRevision ?? null]),
    applicationGenerations: () => ({}),
    applicationRevisions: () => ({}),
    restore: async () => {},
    scheduleCoordinatorSync: (...args) => events.push(['schedule', ...args]),
    waitForCoordinatorSync: async () => { events.push(['wait']); },
    coordinatorSyncRunning: syncRunning,
  });
  return { writes, control, state, events };
}

test('persist retries once after a stale state revision, waiting for the coordinator sync in between', async () => {
  let syncRunning = false;
  const idle = coordinatorWrites({
    responses: [{ ok: false, code: 'STALE_STATE_REVISION' }, { ok: true, stateRevision: 8 }],
    syncRunning: () => syncRunning,
  });
  await idle.writes.persist();
  assert.deepEqual(idle.events, [
    ['send', 'PERSIST_ASSISTANT_STATE'],
    ['schedule'],
    ['schedule'],
    ['wait'],
    ['send', 'PERSIST_ASSISTANT_STATE'],
    ['apply', 8],
  ]);

  syncRunning = true;
  const running = coordinatorWrites({
    responses: [{ ok: false, code: 'STALE_STATE_REVISION' }, { ok: true, stateRevision: 8 }],
    syncRunning: () => syncRunning,
  });
  await running.writes.persist();
  assert.deepEqual(running.events.map(([name]) => name), ['send', 'schedule', 'wait', 'send', 'apply'], 'a running sync is joined, not rescheduled');

  const twice = coordinatorWrites({ responses: [{ ok: false, code: 'STALE_STATE_REVISION' }, { ok: false, code: 'STALE_STATE_REVISION' }] });
  await assert.rejects(twice.writes.persist(), /could not save its current checkpoint/);
  assert.equal(twice.events.filter(([name, type]) => name === 'send' && type === 'PERSIST_ASSISTANT_STATE').length, 2);
});

test('a stale persist response stops the caller with the coordinator stale error', async () => {
  const { writes, events } = coordinatorWrites({
    responses: [{ ok: false, stale: true, applicationId: 'app-1', error: 'Changed in another window.', stateRevision: 9 }],
  });
  await assert.rejects(writes.persist({ applicationIds: ['app-1'] }), { name: 'RunCancelledError', message: 'Changed in another window.' });
  assert.deepEqual(events, [['send', 'PERSIST_ASSISTANT_STATE'], ['apply', 9], ['schedule', 'app-1']]);
});

test('persist cancels the runs of applications the coordinator rejected, and only those', async () => {
  const kept = { id: 'kept' };
  const rejected = { id: 'rejected' };
  const { writes, control, events } = coordinatorWrites({
    responses: [{ ok: true, stateRevision: 8, rejectedApplicationIds: ['rejected'] }],
    apps: [kept, rejected],
  });
  const keptToken = await control.beginApplicationRun(kept);
  const rejectedToken = await control.beginApplicationRun(rejected);
  await assert.rejects(writes.persist(), { name: 'RunCancelledError', message: /paused or changed in another assistant window/ });
  assert.equal(rejectedToken.cancelled, true);
  assert.equal(keptToken.cancelled, false);
  assert.deepEqual(events.at(-1), ['schedule', ['rejected']]);
});

test('a refused lease is a coordinator change when stale, and a lease conflict otherwise', async () => {
  const stale = coordinatorWrites({ responses: [{ allowed: false, stale: true, error: 'The run moved.' }] });
  await assert.rejects(stale.writes.acquireApplicationLease(stale.state.apps[0]), { name: 'RunCancelledError', message: 'The run moved.' });
  assert.deepEqual(stale.events, [['send', 'ACQUIRE_APPLICATION_LEASE'], ['schedule', 'app-1']]);

  const lease = { holder: 'other-window', expiresAt: '2030-01-01T00:00:00.000Z' };
  const conflict = coordinatorWrites({ responses: [{ allowed: false, reason: 'Held elsewhere.', lease }] });
  await assert.rejects(conflict.writes.acquireApplicationLease(conflict.state.apps[0]), (error) => {
    assert.equal(error.name, 'LeaseConflictError');
    assert.equal(error.message, 'Held elsewhere.');
    assert.deepEqual(error.lease, lease);
    return true;
  });
  assert.deepEqual(conflict.events, [['send', 'ACQUIRE_APPLICATION_LEASE']], 'a losing contender does not sync');

  const granted = coordinatorWrites({
    responses: [{ allowed: true, stateRevision: 8, lease: { holder: 'worker-1' }, applicationGeneration: 3, applicationRevision: 5 }],
  });
  const application = granted.state.apps[0];
  await granted.writes.acquireApplicationLease(application);
  assert.deepEqual(application.lease, { holder: 'worker-1' });
  assert.equal(application.controlGeneration, 3);
  assert.equal(application.controlRevision, 5);
  assert.equal(granted.writes.APPLICATION_LEASE_MS, 2 * 60 * 1000);
});

/** Coordinator sync over the real merge rules and a scripted coordinator state. */
function coordinatorSync({ state, response, previewMode = false }) {
  const calls = [];
  const sync = coordinatorSyncModule.create({
    ...coordinatorMergeModule.create({ workQueueEngine }),
    state,
    previewMode,
    workQueueEngine,
    attachApplicationPolicy: (application) => application,
    async requestAssistantState() {
      calls.push('request');
      return response;
    },
    cancelApplicationRun: (application) => calls.push(`cancel:${application.id}`),
    cancelAllRuns: () => calls.push('cancelAll'),
    coordinatorStaleError: (message) => Object.assign(new Error(message), { name: 'RunCancelledError' }),
    canonicalHomeView: () => 'choice',
    render: () => calls.push('render'),
  });
  return { sync, calls };
}

test('coordinator deltas ask for a full sync, a targeted one, or nothing', () => {
  const state = {
    sessionEpoch: 2,
    participantSessionId: 'session-1',
    coordinatorRevision: 5,
    apps: [{ id: 'a', controlGeneration: 1, controlRevision: 0 }, { id: 'b' }],
  };
  const { sync } = coordinatorSync({ state });
  const same = { sessionEpoch: 2, participantSessionId: 'session-1', stateRevision: 5, applicationGenerations: { a: 1 }, applicationRevisions: {} };
  assert.deepEqual(sync.coordinatorDelta(same), { full: false, applicationIds: [] });
  assert.deepEqual(sync.coordinatorDelta(null), { full: false, applicationIds: [] });
  assert.deepEqual(sync.coordinatorDelta({ ...same, sessionEpoch: 3 }), { full: true, applicationIds: [] });
  assert.deepEqual(sync.coordinatorDelta({ ...same, participantSessionId: 'session-2' }), { full: true, applicationIds: [] });
  assert.deepEqual(sync.coordinatorDelta({ ...same, applicationGenerations: { a: 1, unknown: 0 } }), { full: true, applicationIds: [] });
  assert.deepEqual(sync.coordinatorDelta({ ...same, applicationGenerations: { a: 2 }, stateRevision: 6 }), { full: false, applicationIds: ['a'] });
  assert.deepEqual(sync.coordinatorDelta({ ...same, stateRevision: 6 }), { full: true, applicationIds: [] });
  assert.deepEqual(coordinatorSync({ state: { ...state, sessionEpoch: 0 } }).sync.coordinatorDelta(same), { full: false, applicationIds: [] });
});

test('a sync requested during a coordinator mutation waits for the mutation, then runs once', async () => {
  const state = {
    sessionEpoch: 1,
    participantSessionId: 'session-1',
    coordinatorRevision: 1,
    view: 'dashboard',
    currentAppId: null,
    participant: null,
    audit: [],
    apps: [{ id: 'app-1', controlGeneration: 0, copy: 'local' }],
  };
  const response = {
    ok: true,
    sessionEpoch: 1,
    participantSessionId: 'session-1',
    stateRevision: 2,
    applicationGenerations: { 'app-1': 1 },
    applicationRevisions: {},
    session: { participant: { record_id: '1' }, apps: [{ id: 'app-1', copy: 'coordinator' }] },
    queue: { applications: [], audit: [] },
  };
  const { sync, calls } = coordinatorSync({ state, response });
  let finishMutation;
  const mutation = sync.withCoordinatorMutation(() => new Promise((resolve) => { finishMutation = resolve; }));

  sync.scheduleCoordinatorSync('app-1');
  assert.equal(sync.coordinatorSyncRunning(), false, 'no sync starts while the mutation is open');
  sync.scheduleCoordinatorSync('app-1');
  await tick();
  assert.equal(sync.coordinatorSyncRunning(), false);
  assert.deepEqual(calls, []);

  finishMutation();
  await mutation;
  assert.equal(sync.coordinatorSyncRunning(), true);
  await sync.waitForCoordinatorSync();
  assert.equal(sync.coordinatorSyncRunning(), false);
  assert.deepEqual(calls, ['request', 'cancel:app-1', 'render']);
  assert.equal(state.apps[0].copy, 'coordinator');
  assert.equal(state.apps[0].controlGeneration, 1);
  assert.equal(state.coordinatorRevision, 2);

  const preview = coordinatorSync({ state: { ...state, apps: [] }, response, previewMode: true });
  preview.sync.scheduleCoordinatorSync();
  assert.equal(preview.sync.coordinatorSyncRunning(), false, 'the preview never syncs');
});

/** Automatic runs over stub run control; each lease holds until the test releases it. */
function automaticRuns({ apps }) {
  const state = { apps, view: 'dashboard', sessionEpoch: 1, error: '' };
  const tokens = new Map();
  const leases = [];
  const started = [];
  let running = 0;
  let maxRunning = 0;
  const runs = automaticRunsModule.create({
    state,
    previewMode: true,
    activeRun: (id) => tokens.get(id),
    isRunning: (id) => tokens.has(id),
    async beginApplicationRun(application) {
      const token = { cancelled: false };
      tokens.set(application.id, token);
      return token;
    },
    assertApplicationRun: () => {},
    endApplicationRun: (application) => tokens.delete(application.id),
    APPLICATION_LEASE_MS: 2 * 60 * 1000,
    async withApplicationLease(application) {
      started.push(application.id);
      running += 1;
      maxRunning = Math.max(maxRunning, running);
      const outcome = await new Promise((resolve) => leases.push({ id: application.id, resolve }));
      running -= 1;
      if (outcome instanceof Error) throw outcome;
    },
    setApplicationProgress: () => {},
    setCheckpoint: () => {},
    persist: async () => {},
    render: () => {},
    renderDashboardIfVisible: () => {},
  });
  const release = async (outcome) => {
    leases.splice(0).forEach((lease) => lease.resolve(outcome));
    await tick();
  };
  return { runs, state, started, leases, release, maxRunning: () => maxRunning };
}

const eligibleApp = (id) => ({ id, tabId: 7, autoRun: true, status: 'not_started' });

test('only automatic, tab-bound applications that can still fill are eligible to run', () => {
  const { runs } = automaticRuns({ apps: [] });
  const known = { analysis: { assignments: [{ fieldKey: 'f' }] } };
  assert.equal(runs.eligibleAutomaticApplication(eligibleApp('a')), true);
  assert.equal(runs.eligibleAutomaticApplication({ ...eligibleApp('a'), status: 'ready_to_fill' }), true);
  assert.equal(runs.eligibleAutomaticApplication({ ...eligibleApp('a'), status: 'needs_attention', ...known }), true);
  assert.equal(runs.eligibleAutomaticApplication({ ...eligibleApp('a'), status: 'needs_attention' }), false);
  assert.equal(runs.eligibleAutomaticApplication({ ...eligibleApp('a'), status: 'paused' }), false);
  assert.equal(runs.eligibleAutomaticApplication({ ...eligibleApp('a'), autoRun: false }), false);
  assert.equal(runs.eligibleAutomaticApplication({ ...eligibleApp('a'), tabId: null }), false);
  assert.equal(runs.eligibleAutomaticApplication(undefined), false);
});

test('the automatic queue de-duplicates applications and runs at most three at a time', async () => {
  const ids = ['a', 'b', 'c', 'd', 'e', 'f'];
  const harness = automaticRuns({ apps: ids.map(eligibleApp) });
  await harness.runs.enqueueApplicationBatch(['a', 'b', 'a', 'c', 'd', '', 'e']);
  await harness.runs.enqueueApplicationBatch(['d', 'e', 'f']);
  await tick();
  assert.deepEqual(harness.started, ['a', 'b', 'c']);
  await harness.release();
  assert.deepEqual(harness.started, ['a', 'b', 'c', 'd', 'e', 'f']);
  await harness.release();
  assert.equal(harness.maxRunning(), 3);
  assert.equal(harness.leases.length, 0);
});

test('clearing the automatic queue drops queued applications and pending lease retries', async () => {
  const queued = automaticRuns({ apps: ['a', 'b', 'c', 'd', 'e'].map(eligibleApp) });
  await queued.runs.enqueueApplicationBatch(['a', 'b', 'c', 'd', 'e']);
  await tick();
  queued.runs.clear();
  await queued.release();
  assert.deepEqual(queued.started, ['a', 'b', 'c'], 'queued work never starts after clear()');

  const conflict = () => Object.assign(new Error('Held elsewhere.'), { name: 'LeaseConflictError', lease: { expiresAt: new Date().toISOString() } });
  for (const clearBeforeRetry of [false, true]) {
    const retrying = automaticRuns({ apps: [eligibleApp('a')] });
    await retrying.runs.enqueueApplicationBatch(['a']);
    await tick();
    await retrying.release(conflict());
    if (clearBeforeRetry) retrying.runs.clear();
    await wait(400);
    assert.deepEqual(retrying.started, clearBeforeRetry ? ['a'] : ['a', 'a'], `clear before retry: ${clearBeforeRetry}`);
    await retrying.release();
  }
});

function agentRuntime({ state = {}, activeRunCount = () => 0 } = {}) {
  return agentRuntimeModule.create({
    state: { agentProvider: { kind: 'chrome-local' }, agentRuntime: {}, ...state },
    previewMode: true,
    agentPlanner: {},
    setBusy: () => {},
    setApplicationProgress: () => {},
    assertUiGeneration: () => {},
    activeRunCount,
    persist: async () => {},
  });
}

test('planner start-up progress names the model download, the provider, and each planning phase', () => {
  const local = agentRuntime();
  assert.equal(local.agentProgressMessage({ phase: 'download', progress: 0.416 }), 'Downloading Chrome\'s on-device language model 42%…');
  assert.equal(local.agentProgressMessage({ phase: 'download', progress: 0 }), 'Downloading Chrome\'s on-device language model…');
  assert.equal(local.agentProgressMessage({ phase: 'starting' }), 'Starting three on-device form agents…');
  assert.equal(local.agentProgressMessage({ phase: 'planning' }), 'Field-mapping and gap-analysis agents are reviewing this page…');
  assert.equal(local.agentProgressMessage({ phase: 'reviewing' }), 'The independent review agent is checking the proposed plan…');
  assert.equal(local.agentProgressMessage(), 'Preparing the on-device form agents…');
  for (const [provider, title] of [['codex', 'Codex CLI'], ['claude', 'Claude Code']]) {
    const cli = agentRuntime({ state: { agentProvider: { kind: 'local-cli', provider } } });
    assert.equal(cli.agentProgressMessage({ phase: 'starting' }), `Connecting three planner roles to ${title}…`);
  }
});

test('client links group BenefitsCal programs, keep one program otherwise, and map question input types', async () => {
  const { clientLinkPrograms, apiInputType, saveAgentProvider } = agentRuntime({ activeRunCount: () => 1 });
  assert.deepEqual(clientLinkPrograms(['calfresh', 'wic', 'medical', 'calworks']), ['calfresh', 'medical', 'calworks']);
  assert.deepEqual(clientLinkPrograms(['wic', 'calfresh']), ['wic']);
  assert.deepEqual(clientLinkPrograms([null, 'ihss', 'wic']), ['ihss']);
  assert.deepEqual(clientLinkPrograms(undefined), []);
  assert.equal(apiInputType({ inputType: 'multi_choice' }), 'checkbox');
  for (const type of ['text', 'select', 'radio', 'checkbox', 'date', 'number']) assert.equal(apiInputType({ inputType: type }), type);
  assert.equal(apiInputType({ inputType: 'combobox', options: [{ label: 'A' }] }), 'select');
  assert.equal(apiInputType({ inputType: 'combobox', options: [] }), 'text');
  assert.equal(apiInputType({}), 'text');
  await assert.rejects(saveAgentProvider({}, 0), /Wait for the active application runs to pause/);
});

function recertificationCaseload({ state, previewMode = false, generation = () => 0 }) {
  const calls = [];
  const caseload = recertificationCaseloadModule.create({
    state: { recertifications: [], recertificationWorkspace: {}, apps: [], participant: null, ...state },
    previewMode,
    recertificationEngine: {
      normalizeCaseload: (cases) => cases,
      mergeWorkspace: (item, saved) => ({ ...item, saved: saved || null }),
    },
    async sendRuntime(message) {
      calls.push(['send', message.type]);
      return { ok: true, cases: [{ id: 'r-1' }], source: 'Fictional' };
    },
    setBusy: () => {},
    render: () => {},
    assertUiGeneration: (token) => calls.push(['assertUiGeneration', token]),
    currentUiGeneration: generation,
    commitParticipant: async () => calls.push(['commitParticipant']),
    persist: async () => {},
    prepareAgentRuntime: async () => {},
    openSelectedPrograms: async () => [],
    enqueueApplicationBatch: async () => {},
  });
  return { caseload, calls };
}

test('recertification preparation refuses an unready case and a different client while applications are open', async () => {
  const unready = recertificationCaseload({ state: {} });
  await assert.rejects(unready.caseload.prepareRecertification({ readyToPrepare: false, recordId: '1' }, 0), /Complete the data check/);
  assert.deepEqual(unready.calls, []);

  const busy = recertificationCaseload({ state: { participant: { record_id: '111' }, apps: [{ id: 'app-1' }] } });
  await assert.rejects(
    busy.caseload.prepareRecertification({ readyToPrepare: true, recordId: '222', displayName: 'Client' }, 0),
    /Finish or end the active client session/,
  );
  assert.deepEqual(busy.calls, []);
});

test('recertification answers are kept in session storage only, and the caseload reads the live UI generation', async () => {
  globalThis.chrome = fakeChrome();
  const item = {
    id: 'r-1',
    requirements: [{ key: 'income', status: 'confirmed', note: 'Pay stub', confirmedAt: '2026-01-01T00:00:00.000Z' }],
    consent: { status: 'authorized' },
    outreach: { status: 'drafted' },
  };
  let generation = 3;
  const { caseload, calls } = recertificationCaseload({ state: {}, generation: () => generation });
  await caseload.saveRecertificationWorkspace(item);
  assert.deepEqual(globalThis.chrome.calls.map(([name]) => name), ['storage.session.set']);
  const [[, written]] = globalThis.chrome.calls;
  assert.deepEqual(Object.keys(written), ['nava:recertification-workspace']);
  assert.deepEqual(written['nava:recertification-workspace']['r-1'].requirements.income.status, 'confirmed');

  generation = 4;
  await caseload.loadRecertifications();
  assert.deepEqual(calls.find(([name]) => name === 'assertUiGeneration'), ['assertUiGeneration', 4]);
  assert.ok(globalThis.chrome.calls.every(([name]) => name.startsWith('storage.session.')));

  globalThis.chrome = fakeChrome();
  const preview = recertificationCaseload({ state: {}, previewMode: true });
  await preview.caseload.saveRecertificationWorkspace(item);
  assert.deepEqual(globalThis.chrome.calls, [], 'the preview writes no browser storage');
  delete globalThis.chrome;
});

function connectorActions(connector) {
  const state = { connector };
  return connectorActionsModule.create({
    ...uiDispatchModule.handlerContract(state),
    state,
    managedConnector: () => state.connector?.mode === 'managed',
    connectorEngine,
  });
}

/** A FormData-like reader over a plain object. */
const formData = (fields) => ({ get: (name) => fields[name] ?? null });

test('resubmitting the saved connector source keeps its mappings under the next mapping version', () => {
  const saved = {
    mode: 'managed',
    provider: 'apricot360',
    backendUrl: 'http://127.0.0.1:4789',
    connectionId: 'nava-demo',
    sourceId: '99',
    mappings: { firstName: 'first_name' },
    mappingVersion: 2,
  };
  const fields = {
    provider: 'apricot360',
    backendUrl: ' http://127.0.0.1:4789 ',
    connectionId: 'nava-demo',
    sourceId: '99',
    organizationName: ' Riverside ',
    maxAgeDays: '30',
  };
  const same = connectorActions(saved).connectorConfigFromForm(formData(fields));
  assert.equal(same.mappingVersion, 3);
  assert.equal(same.mappings, saved.mappings);
  assert.equal(same.backendUrl, 'http://127.0.0.1:4789');
  assert.equal(same.organizationName, 'Riverside');
  assert.equal(same.maxAgeDays, 30);

  const otherSource = connectorActions(saved).connectorConfigFromForm(formData({ ...fields, sourceId: '100' }));
  assert.equal(otherSource.mappingVersion, 1);
  assert.deepEqual(otherSource.mappings, {});

  const unmanaged = connectorActions({ ...saved, mode: 'demo' }).connectorConfigFromForm(formData(fields));
  assert.equal(unmanaged.mappingVersion, 1);
  assert.deepEqual(unmanaged.mappings, {});
});

test('change events reach only their own select handlers; prototype ids do nothing', () => {
  const elements = {
    'model-companion-fields': { hidden: true },
    'connector-source-id': { placeholder: '' },
  };
  const sourceLabel = { textContent: '' };
  const listeners = {};
  globalThis.document = {
    getElementById: (id) => elements[id] || null,
    querySelector: (selector) => (selector === 'label[for="connector-source-id"]' ? sourceLabel : null),
    addEventListener: (type, listener) => { listeners[`document:${type}`] = listener; },
  };
  const state = { view: 'choice', error: '' };
  const contract = uiDispatchModule.handlerContract(state);
  const deps = { ...contract, state, connectorEngine, managedConnector: () => false };
  const dispatch = uiDispatchModule.create({
    state,
    appRoot: { addEventListener: (type, listener) => { listeners[type] = listener; } },
    render: () => {},
    assertUiGeneration: () => {},
    currentUiGeneration: () => 0,
    agentActions: agentActionsModule.create(deps),
    recertificationActions: recertificationActionsModule.create(deps),
    intakeActions: intakeActionsModule.create(deps),
    connectorActions: connectorActionsModule.create(deps),
    applicationActions: applicationActionsModule.create(deps),
  });
  dispatch.installListeners();
  assert.deepEqual(Object.keys(listeners).sort(), ['change', 'document:click', 'submit']);
  assert.deepEqual([...dispatch.CHANGE_HANDLERS.keys()], ['model-provider', 'connector-provider']);

  listeners.change({ target: { id: 'model-provider', value: 'codex' } });
  assert.equal(elements['model-companion-fields'].hidden, false);
  listeners.change({ target: { id: 'model-provider', value: 'chrome-local' } });
  assert.equal(elements['model-companion-fields'].hidden, true);

  listeners.change({ target: { id: 'connector-provider', value: 'apricot360' } });
  assert.equal(sourceLabel.textContent, 'Apricot form ID');
  assert.equal(elements['connector-source-id'].placeholder, 'Apricot form ID');
  listeners.change({ target: { id: 'connector-provider', value: 'no-such-provider' } });
  assert.equal(sourceLabel.textContent, 'Apricot form ID');

  for (const id of ['toString', 'constructor', '__proto__', 'hasOwnProperty', 'other-select', '']) {
    assert.doesNotThrow(() => listeners.change({ target: { id, value: 'x' } }), id);
  }
  assert.equal(elements['model-companion-fields'].hidden, true);
  delete globalThis.document;
});

test('a coordinator echo of the pause does not throw the caseworker off the handoff form', () => {
  const survives = coordinatorSyncModule.viewSurvivesCoordinatorChange;
  const paused = { id: 'app-1', status: 'paused', handoff: null };
  const state = { apps: [paused], handoffApplicationId: 'app-1' };
  assert.equal(survives(state, 'handoff'), true);
  assert.equal(survives(state, 'dashboard'), true);
  assert.equal(survives(state, 'review'), false, 'detail screens of a changed application still close');
  assert.equal(survives({ ...state, apps: [] }, 'handoff'), false, 'the application is gone');
  const handedOff = { ...paused, handoff: { to: 'Eligibility Team', createdAt: '2026-10-07T00:00:00.000Z', acceptedAt: null } };
  assert.equal(survives({ ...state, apps: [handedOff] }, 'handoff'), false, 'another window already handed it off');
});

test('a cancelled run stops counting as running for the card, but still holds the application until it settles', async () => {
  const state = { apps: [{ id: 'app-1', controlGeneration: 0 }], sessionEpoch: 'epoch-1', workerId: 'window-a' };
  const runs = runControlModule.create({ state, previewMode: true, checkpoint: () => ({}), revokeApplicationRun: async () => {}, onCancelAll: () => {} });
  const application = state.apps[0];
  const token = await runs.beginApplicationRun(application);
  assert.equal(runs.isRunning('app-1'), true);
  assert.equal(runs.runActive('app-1'), true);
  runs.cancelApplicationRun(application);
  assert.equal(runs.runActive('app-1'), false, 'the card shows the stop at once');
  assert.equal(runs.isRunning('app-1'), true, 'automatic runs still wait for the old run to settle');
  runs.endApplicationRun(application, token);
  assert.equal(runs.isRunning('app-1'), false);
});
