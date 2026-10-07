// Side-panel click/submit dispatch and coordinator-merge helpers, loaded from the real action, dispatch and merge modules with recording stubs.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const workQueueEngine = require('../shared/work-queue-engine.js');
const coordinatorMerge = require('../sidepanel/coordinator-merge.js');

// The action tables in dispatcher order, then the dispatcher, as sidepanel/index.html loads them.
const DISPATCH_SCRIPTS = [
  'sidepanel/actions-agent.js',
  'sidepanel/actions-recertification.js',
  'sidepanel/actions-intake.js',
  'sidepanel/actions-connector.js',
  'sidepanel/actions-applications.js',
  'sidepanel/ui-dispatch.js',
].map((file) => ({ file, source: fs.readFileSync(path.resolve(__dirname, '..', file), 'utf8') }));

// Every data-action and form id the panel handled before the handler tables existed.
const CLICK_ACTION_NAMES = [
  'save-planner', 'client-link', 'enable-agent', 'home', 'open-recertifications', 'back-recertifications',
  'review-recertification', 'draft-recertification-outreach', 'complete-recertification-outreach', 'prepare-recertification',
  'choose-id', 'choose-json', 'configure-connector', 'back-providers', 'select-provider', 'back-connector',
  'local-connector-settings', 'reset-connector', 'choose-document', 'back-choice', 'back-record-id',
  'confirm-connector-record', 'back-programs', 'back-document', 'change-client', 'back-dashboard', 'add-application',
  'reload-source', 'export-audit', 'use-sample', 'start-over', 'answer', 'answer-run', 'fill', 'run', 'review', 'rescan',
  'go-tab', 'scan-application', 'resume', 'resume-current', 'resume-human-checkpoint', 'open-handoff', 'pause',
  'accept-handoff', 'analyze-current',
];
const SUBMIT_FORM_IDS = [
  'model-provider-form', 'recertification-intake-form', 'handoff-form', 'connector-form', 'connector-mapping-form',
  'record-form', 'json-form', 'document-form', 'document-review-form', 'program-form', 'questions-form',
];

/** A FormData stand-in over a plain { name: value | value[] } object. */
class FakeFormData {
  constructor(form) {
    this.fields = form?.fields || {};
  }

  get(name) {
    const value = this.fields[name];
    if (value === undefined) return null;
    return Array.isArray(value) ? value[0] : value;
  }

  getAll(name) {
    const value = this.fields[name];
    if (value === undefined) return [];
    return Array.isArray(value) ? value : [value];
  }
}

/** Loads the action modules and the dispatcher into one context over recording stubs; `calls` lists every stubbed side effect in order. */
function dispatchHarness(overrides = {}) {
  const calls = [];
  const note = (name, result) => (...args) => {
    calls.push([name, ...args]);
    return result;
  };
  const elements = Object.fromEntries([
    'client-json', 'connector-provider', 'connector-org', 'connector-url', 'connection-id', 'connector-source-id',
  ].map((id) => [id, {
    id,
    value: '',
    dispatchEvent(event) {
      calls.push(['dispatchEvent', id, event.type, event.bubbles]);
    },
  }]));
  const context = {
    state: {
      error: 'previous error',
      view: 'dashboard',
      apps: [],
      currentAppId: null,
      participant: { record_id: '1' },
      connectorDraft: { provider: 'x' },
      connectorSchema: [{}],
      pendingConnectorRecord: { _connector: {} },
      documentResult: { fields: [] },
      handoffApplicationId: 'app-1',
      previewPage: 3,
      recertifications: [],
      ...overrides.state,
    },
    previewMode: true,
    currentUiGeneration: () => 0,
    DEMO_RECORDS: { 339619: { record_id: '339619', participant: { name: { first: 'Celeste' } } } },
    document: { getElementById: (id) => elements[id] || null },
    Event: class {
      constructor(type, init = {}) {
        this.type = type;
        this.bubbles = Boolean(init.bubbles);
      }
    },
    FormData: FakeFormData,
    decoded: (value) => decodeURIComponent(String(value)),
    assertUiGeneration: note('assertUiGeneration'),
    render: note('render'),
    cancelUiBoundRuns: async () => { calls.push(['cancelUiBoundRuns']); },
    cancelPendingUiWork: note('cancelPendingUiWork', 42),
    canonicalHomeView: () => 'programs',
    cancelAllRuns: note('cancelAllRuns'),
    recordAudit: note('recordAudit'),
    clearAssistantState: async () => { calls.push(['clearAssistantState']); },
    exportAuditLog: async (token) => { calls.push(['exportAuditLog', token]); },
    prepareRecertification: async (item, token) => { calls.push(['prepareRecertification', item.id, token]); },
    recertificationById: () => context.state.recertifications.find((item) => item.id === context.state.currentRecertificationId) || null,
    saveAgentProvider: async (form, token) => { calls.push(['saveAgentProvider', form.id, token]); },
    mintClientLink: async (application) => { calls.push(['mintClientLink', application.id]); },
    withNewApplicationRun: async (application, action, options) => {
      calls.push(['withNewApplicationRun', application.id, options]);
      return action('run-token');
    },
    withApplicationLease: async (application, action) => {
      calls.push(['withApplicationLease', application.id]);
      return action();
    },
    fillApplication: async (application, assignments, unresolved, options) => {
      calls.push(['fillApplication', application.id, assignments, unresolved, options]);
    },
    runThroughApplication: async (application, assignments, unresolved, options) => {
      calls.push(['runThroughApplication', application.id, assignments, unresolved, options]);
    },
    ...overrides.stubs,
  };
  vm.createContext(context);
  DISPATCH_SCRIPTS.forEach(({ file, source }) => vm.runInContext(source, context, { filename: file }));
  const deps = { ...context, ...context.NavaUiDispatch.handlerContract(context.state) };
  const agentActions = context.NavaAgentActions.create(deps);
  const recertificationActions = context.NavaRecertificationActions.create(deps);
  const intakeActions = context.NavaIntakeActions.create(deps);
  const connectorActions = context.NavaConnectorActions.create(deps);
  const applicationActions = context.NavaApplicationActions.create(deps);
  const { onClick, onSubmit, CLICK_ACTIONS, SUBMIT_ACTIONS } = context.NavaUiDispatch.create({
    ...deps,
    agentActions,
    recertificationActions,
    intakeActions,
    connectorActions,
    applicationActions,
  });
  return {
    onClick,
    onSubmit,
    answersFromQuestionsForm: applicationActions.answersFromQuestionsForm,
    CLICK_ACTIONS,
    SUBMIT_ACTIONS,
    groupedClickActions: [
      agentActions.AGENT_CLICK_ACTIONS,
      recertificationActions.RECERTIFICATION_CLICK_ACTIONS,
      intakeActions.INTAKE_CLICK_ACTIONS,
      connectorActions.CONNECTOR_CLICK_ACTIONS,
      applicationActions.APPLICATION_CLICK_ACTIONS,
    ],
    groupedSubmitActions: [
      agentActions.AGENT_SUBMIT_ACTIONS,
      recertificationActions.RECERTIFICATION_SUBMIT_ACTIONS,
      intakeActions.INTAKE_SUBMIT_ACTIONS,
      connectorActions.CONNECTOR_SUBMIT_ACTIONS,
      applicationActions.APPLICATION_SUBMIT_ACTIONS,
    ],
    state: context.state,
    calls,
    elements,
  };
}

function click(harness, action, data = {}, uiToken = 7) {
  return harness.onClick({ dataset: { action, ...data } }, uiToken);
}

function callNames(calls) {
  return calls.map(([name]) => name);
}

test('every click action and form id has exactly one handler in an own-property table', () => {
  const harness = dispatchHarness();
  const clickEntries = harness.groupedClickActions.flat();
  const submitEntries = harness.groupedSubmitActions.flat();

  assert.equal(harness.CLICK_ACTIONS.constructor.name, 'Map');
  assert.equal(harness.SUBMIT_ACTIONS.constructor.name, 'Map');
  assert.deepEqual([...harness.CLICK_ACTIONS.keys()].sort(), [...CLICK_ACTION_NAMES].sort());
  assert.deepEqual([...harness.SUBMIT_ACTIONS.keys()].sort(), [...SUBMIT_FORM_IDS].sort());
  assert.equal(clickEntries.length, harness.CLICK_ACTIONS.size, 'no action is claimed by two groups');
  assert.equal(submitEntries.length, harness.SUBMIT_ACTIONS.size, 'no form id is claimed by two groups');
  clickEntries.concat(submitEntries).forEach(([key, handler]) => assert.equal(typeof handler, 'function', key));
});

test('every data-action a screen renders reaches a handler, and the planner form only re-renders', () => {
  const root = path.resolve(__dirname, '..');
  const screens = ['sidepanel/index.html', ...fs.readdirSync(path.join(root, 'sidepanel'))
    .filter((file) => /^view-.*\.js$/.test(file))
    .map((file) => `sidepanel/${file}`)]
    .map((file) => fs.readFileSync(path.join(root, file), 'utf8'))
    .join('\n');
  const { CLICK_ACTIONS, SUBMIT_ACTIONS } = dispatchHarness();
  const rendered = [...screens.matchAll(/data-action="([a-z-]+)"/g)].map((match) => match[1]);
  const quotedInTemplates = [...screens.matchAll(/data-action="\$\{[^}]*\}"/g)]
    .flatMap((match) => [...match[0].matchAll(/'([a-z-]+)'/g)].map((value) => value[1]));
  const backAction = /const backAction = state\.participant \? '([a-z-]+)' : '([a-z-]+)'/.exec(screens);
  assert.ok(rendered.length > 30 && quotedInTemplates.length >= 4 && backAction);
  [...rendered, ...quotedInTemplates, backAction[1], backAction[2]].forEach((action) => {
    assert.ok(CLICK_ACTIONS.has(action), `no handler for data-action ${action}`);
  });
  [...screens.matchAll(/<form id="([a-z-]+)"/g)].map((match) => match[1])
    .filter((formId) => formId !== 'planner-form')
    .forEach((formId) => assert.ok(SUBMIT_ACTIONS.has(formId), `no handler for form ${formId}`));
  assert.equal(SUBMIT_ACTIONS.has('planner-form'), false);
});

test('unknown actions, including prototype keys, clear the error and re-render under the event token', async () => {
  for (const action of ['toString', '__proto__', 'constructor', 'hasOwnProperty', 'no-such-action', '']) {
    const harness = dispatchHarness();
    await click(harness, action);
    assert.equal(harness.state.error, '', action);
    assert.deepEqual(harness.calls, [['assertUiGeneration', 7], ['render']], action);
  }
});

test('screen-only actions switch the view and re-render', async () => {
  const expected = {
    'choose-id': 'record',
    'choose-json': 'json',
    'back-choice': 'choice',
    'back-programs': 'programs',
    'reload-source': 'choice',
    'back-providers': 'providers',
    'back-connector': 'connector',
    'back-recertifications': 'recertifications',
  };
  for (const [action, view] of Object.entries(expected)) {
    const harness = dispatchHarness();
    await click(harness, action);
    assert.equal(harness.state.view, view, action);
    assert.deepEqual(harness.calls, [['assertUiGeneration', 7], ['render']], action);
  }
});

test('home awaits UI-bound run cancellation before starting a new UI generation, then renders under it', async () => {
  const harness = dispatchHarness();
  await click(harness, 'home');
  assert.deepEqual(harness.calls, [
    ['cancelUiBoundRuns'],
    ['cancelPendingUiWork'],
    ['assertUiGeneration', 42],
    ['render'],
  ]);
  assert.equal(harness.state.view, 'programs');
  assert.equal(harness.state.connectorDraft, null);
  assert.equal(harness.state.connectorSchema.length, 0);
  assert.equal(harness.state.pendingConnectorRecord, null);
  assert.equal(harness.state.documentResult, null);
  assert.equal(harness.state.handoffApplicationId, null);
});

test('change-client and start-over end the session under a new UI generation; only start-over audits it', async () => {
  for (const action of ['change-client', 'start-over']) {
    const harness = dispatchHarness({ state: { apps: [{ id: 'app-1' }], currentAppId: 'app-1' } });
    await click(harness, action);
    assert.deepEqual(callNames(harness.calls), [
      'cancelAllRuns',
      'cancelPendingUiWork',
      ...(action === 'start-over' ? ['recordAudit'] : []),
      'clearAssistantState',
      'assertUiGeneration',
      'render',
    ], action);
    assert.deepEqual(harness.calls.find(([name]) => name === 'assertUiGeneration'), ['assertUiGeneration', 42]);
    if (action === 'start-over') assert.deepEqual(harness.calls[2], ['recordAudit', 'session_ended', null]);
    assert.equal(harness.state.participant, null);
    assert.equal(harness.state.apps.length, 0);
    assert.equal(harness.state.currentAppId, null);
    assert.equal(harness.state.previewPage, 1);
    assert.equal(harness.state.view, 'choice');
  }
});

test('in-place actions return without the final generation check or render', async () => {
  const sample = dispatchHarness();
  await click(sample, 'use-sample');
  assert.equal(sample.elements['client-json'].value, JSON.stringify({ record_id: '339619', participant: { name: { first: 'Celeste' } } }, null, 2));
  assert.deepEqual(sample.calls, []);

  const connector = dispatchHarness();
  await click(connector, 'local-connector-settings');
  assert.equal(connector.elements['connector-provider'].value, 'apricot360');
  assert.equal(connector.elements['connector-org'].value, 'Riverside Community Services');
  assert.equal(connector.elements['connector-url'].value, 'http://127.0.0.1:4789');
  assert.equal(connector.elements['connection-id'].value, 'nava-demo');
  assert.equal(connector.elements['connector-source-id'].value, '99');
  assert.deepEqual(connector.calls, [['dispatchEvent', 'connector-provider', 'change', true]]);

  const exported = dispatchHarness();
  await click(exported, 'export-audit');
  assert.deepEqual(exported.calls, [['exportAuditLog', 7]]);

  const recertification = dispatchHarness({ state: { recertifications: [{ id: 'r-1' }], currentRecertificationId: 'r-1' } });
  await click(recertification, 'prepare-recertification');
  assert.deepEqual(recertification.calls, [['prepareRecertification', 'r-1', 7]]);

  const missing = dispatchHarness();
  await assert.rejects(click(missing, 'prepare-recertification'), /no longer in the current caseload/);
  assert.deepEqual(missing.calls, []);
});

test('a client link without a current application stops quietly; with one it renders, then the dispatcher renders', async () => {
  const none = dispatchHarness();
  await click(none, 'client-link');
  assert.deepEqual(none.calls, []);

  const linked = dispatchHarness({ state: { apps: [{ id: 'app-1' }], currentAppId: 'app-1' } });
  await click(linked, 'client-link');
  assert.deepEqual(linked.calls, [
    ['mintClientLink', 'app-1'],
    ['assertUiGeneration', 7],
    ['render'],
    ['assertUiGeneration', 7],
    ['render'],
  ]);
});

test('card actions require a live application, make it current, and run under a UI-bound lease', async () => {
  const missing = dispatchHarness({ state: { apps: [{ id: 'app-1' }], currentAppId: 'app-1' } });
  await assert.rejects(click(missing, 'fill', { app: 'gone' }), /That application is no longer available\./);
  assert.equal(missing.state.currentAppId, 'app-1');
  assert.deepEqual(missing.calls, []);

  const fill = dispatchHarness({ state: { apps: [{ id: 'app 2' }] } });
  await click(fill, 'fill', { app: 'app%202' });
  assert.equal(fill.state.currentAppId, 'app 2');
  assert.deepEqual(JSON.parse(JSON.stringify(fill.calls)), [
    ['withNewApplicationRun', 'app 2', { uiBound: true }],
    ['withApplicationLease', 'app 2'],
    ['fillApplication', 'app 2', [], [], { runToken: 'run-token' }],
    ['assertUiGeneration', 7],
    ['render'],
  ]);

  const run = dispatchHarness({ state: { apps: [{ id: 'app-3' }], view: 'review' } });
  await click(run, 'run', { app: 'app-3' });
  assert.deepEqual(callNames(run.calls), [
    'render', 'withNewApplicationRun', 'withApplicationLease', 'runThroughApplication', 'assertUiGeneration', 'render',
  ]);
  assert.equal(run.state.view, 'dashboard');
  assert.deepEqual(JSON.parse(JSON.stringify(run.calls[3][4])), { background: true, runToken: 'run-token' });

  for (const [action, autoRun] of [['answer', false], ['answer-run', true]]) {
    const answer = dispatchHarness({ state: { apps: [{ id: 'app-4', autoRun: !autoRun }] } });
    await click(answer, action, { app: 'app-4' });
    assert.equal(answer.state.apps[0].autoRun, autoRun);
    assert.equal(answer.state.view, 'questions');
  }
});

test('submit handlers that render for themselves skip the final check; unknown forms re-render', async () => {
  const provider = dispatchHarness();
  await provider.onSubmit({ id: 'model-provider-form' }, 5);
  assert.deepEqual(provider.calls, [['assertUiGeneration', 5], ['saveAgentProvider', 'model-provider-form', 5], ['render']]);
  assert.equal(provider.state.error, '');

  for (const formId of ['planner-form', 'toString', '']) {
    const unknown = dispatchHarness();
    await unknown.onSubmit({ id: formId }, 5);
    assert.deepEqual(unknown.calls, [['assertUiGeneration', 5], ['assertUiGeneration', 5], ['render']], formId);
  }
});

test('the questions form fans multi-select answers out to explicit yes and no writes and keeps blanks open', () => {
  const { answersFromQuestionsForm } = dispatchHarness();
  const gaps = [
    { fieldKey: 'name', label: 'Name', purpose: 'firstName', sensitive: false },
    { fieldKey: 'blank', label: 'Blank' },
    {
      fieldKey: 'group',
      inputType: 'multi_choice',
      members: [
        { fieldKey: 'a', label: 'A', purpose: 'pa' },
        { fieldKey: 'b', label: 'B', purpose: 'pb', sensitive: 1 },
      ],
    },
    { fieldKey: 'none', inputType: 'multi_choice', members: [{ fieldKey: 'c', label: 'C' }] },
    { fieldKey: 'conflict', inputType: 'multi_choice', members: [{ fieldKey: 'd', label: 'D' }] },
    { fieldKey: 'unanswered', inputType: 'multi_choice', members: [{ fieldKey: 'e', label: 'E' }] },
  ];
  const data = new FakeFormData({
    fields: {
      'answer-0': '  Celeste ',
      'answer-1': '   ',
      'answer-2': ['b'],
      'answer-3': ['__none__'],
      'answer-4': ['__none__', 'd'],
    },
  });
  const { userAssignments, unresolved } = JSON.parse(JSON.stringify(answersFromQuestionsForm(gaps, data)));
  const answer = { source: 'user', detail: 'Your answer in this browser session' };
  assert.deepEqual(userAssignments, [
    { fieldKey: 'name', label: 'Name', purpose: 'firstName', value: 'Celeste', ...answer, sensitive: false },
    { fieldKey: 'a', label: 'A', purpose: 'pa', value: 'no', ...answer, sensitive: false },
    { fieldKey: 'b', label: 'B', purpose: 'pb', value: 'yes', ...answer, sensitive: true },
    { fieldKey: 'c', label: 'C', value: 'no', ...answer, sensitive: false },
  ]);
  assert.deepEqual(unresolved.map((gap) => gap.fieldKey), ['blank', 'conflict', 'unanswered']);
});

test('questions-form submission runs automatically from the dashboard or fills in place, with the parsed answers', async () => {
  for (const autoRun of [true, false]) {
    const application = { id: 'app-1', autoRun, analysis: { gaps: [{ fieldKey: 'f', label: 'F' }] } };
    const harness = dispatchHarness({ state: { apps: [application], currentAppId: 'app-1', view: 'questions' } });
    await harness.onSubmit({ id: 'questions-form', fields: { 'answer-0': 'yes' } }, 3);
    const step = harness.calls.find(([name]) => name === (autoRun ? 'runThroughApplication' : 'fillApplication'));
    assert.ok(step, `autoRun ${autoRun}`);
    assert.deepEqual(JSON.parse(JSON.stringify(step[2])).map((item) => item.value), ['yes']);
    assert.deepEqual(JSON.parse(JSON.stringify(step[4])), autoRun ? { background: true, runToken: 'run-token' } : { runToken: 'run-token' });
    assert.equal(harness.state.view, autoRun ? 'dashboard' : 'questions');
    assert.deepEqual(harness.calls.at(-2), ['assertUiGeneration', 3]);
    assert.deepEqual(harness.calls.at(-1), ['render']);
  }
});

function coordinatorHelpers() {
  return coordinatorMerge.create({ workQueueEngine });
}

test('coordinator merge keeps unchanged local copies, takes changed ones, and appends locally unpersisted applications', () => {
  const { mergeApplicationsWithCoordinator, controlDiffersFromCoordinator } = coordinatorHelpers();
  const local = {
    same: { id: 'same', controlGeneration: 1, controlRevision: 2, copy: 'local' },
    moved: { id: 'moved', controlGeneration: 1, controlRevision: 0, copy: 'local' },
    removed: { id: 'removed', controlGeneration: 0, controlRevision: 0, copy: 'local' },
    unsaved: { id: 'unsaved', copy: 'local' },
  };
  const coordinator = {
    applicationGenerations: { same: 1, moved: 2, removed: 0 },
    applicationRevisions: { same: 2, moved: 0 },
  };
  const authoritative = [
    { id: 'new', copy: 'authoritative' },
    { id: 'moved', copy: 'authoritative' },
    { id: 'same', copy: 'authoritative' },
  ];
  const { apps, changedIds, localById } = mergeApplicationsWithCoordinator(Object.values(local), authoritative, coordinator);

  assert.deepEqual(Array.from(apps, (application) => `${application.id}:${application.copy}`), [
    'new:authoritative',
    'moved:authoritative',
    'same:local',
    'unsaved:local',
  ]);
  assert.equal(apps[2], local.same);
  assert.deepEqual([...changedIds], ['moved', 'removed']);
  assert.equal(localById.get('removed'), local.removed);
  assert.equal(controlDiffersFromCoordinator(local.same, coordinator), false);
  assert.equal(controlDiffersFromCoordinator(local.moved, coordinator), true);
  assert.equal(controlDiffersFromCoordinator({ id: 'x', controlRevision: 1 }, coordinator), true);
  assert.equal(controlDiffersFromCoordinator({ id: 'x' }, {}), false);
});

test('coordinator audit merge keeps session events and kept applications\' events, sorted by time', () => {
  const { mergeAuditWithCoordinator } = coordinatorHelpers();
  const event = (id, at, applicationId = '') => ({ id, type: 'application_added', at, applicationId, details: {} });
  const merged = mergeAuditWithCoordinator(
    [event('local-kept', '2026-01-03T00:00:00.000Z', 'kept'), event('local-dropped', '2026-01-01T00:00:00.000Z', 'dropped'), event('session', '2026-01-02T00:00:00.000Z')],
    [event('remote', '2026-01-04T00:00:00.000Z', 'dropped'), event('remote-early', '2026-01-01T12:00:00.000Z', 'kept')],
    new Set(['kept']),
  );
  assert.deepEqual(Array.from(merged, (item) => item.id), ['remote-early', 'session', 'local-kept', 'remote']);
});

test('after a sync the current application survives, else the saved choice is adopted when it still exists', () => {
  const { currentApplicationAfterSync } = coordinatorHelpers();
  const apps = [{ id: 'a' }, { id: 'b' }];
  assert.equal(currentApplicationAfterSync(apps, 'a', 'b'), 'a');
  assert.equal(currentApplicationAfterSync(apps, 'gone', 'b'), 'b');
  assert.equal(currentApplicationAfterSync(apps, 'gone', 'missing'), null);
  assert.equal(currentApplicationAfterSync(apps, null, undefined), null);
});
