const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const connectorEngine = require('../shared/connector-engine.js');
const workQueueEngine = require('../shared/work-queue-engine.js');
const programCatalog = require('../shared/program-catalog.js');
const recertificationEngine = require('../shared/recertification-engine.js');

// Shared engines the harness hands to the service worker as required globals.
const ENGINE_IMPORTS = [
  'shared/connector-engine.js',
  'shared/work-queue-engine.js',
  'shared/program-catalog.js',
  'shared/recertification-engine.js',
];
// The rest of background.js's imports, run in the harness context in background.js import order.
const SERVICE_WORKER_SCRIPTS = [
  'shared/demo-connector-data.js',
  'background/coordinator-rules.js',
  'background/client-session.js',
  'background/application-runs.js',
  'background/connector-client.js',
];

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function storageArea(initial = {}) {
  const data = clone(initial);
  return {
    data,
    async get(keys) {
      if (typeof keys === 'string') return { [keys]: clone(data[keys]) };
      if (Array.isArray(keys)) return Object.fromEntries(keys.map((key) => [key, clone(data[key])]));
      if (!keys) return clone(data);
      return Object.fromEntries(Object.entries(keys).map(([key, fallback]) => [key, clone(data[key] ?? fallback)]));
    },
    async set(values) {
      Object.entries(values).forEach(([key, value]) => { data[key] = clone(value); });
    },
    async remove(keys) {
      (Array.isArray(keys) ? keys : [keys]).forEach((key) => { delete data[key]; });
    },
  };
}

function backgroundHarness() {
  const local = storageArea();
  const session = storageArea();
  let messageListener;
  let removedListener;
  let tabMessageHandler = async () => ({ ok: true });
  const tabMessages = [];
  const tabMessageWaiters = [];
  const chrome = {
    storage: { local, session },
    runtime: {
      onInstalled: { addListener() {} },
      onStartup: { addListener() {} },
      onMessage: { addListener(listener) { messageListener = listener; } },
    },
    tabs: {
      onRemoved: { addListener(listener) { removedListener = listener; } },
      async create({ url }) { return { id: 100, url }; },
      sendMessage(tabId, message, options) {
        const entry = { tabId, message: clone(message), options: clone(options) };
        tabMessages.push(entry);
        tabMessageWaiters.splice(0).forEach((waiter) => waiter(entry));
        return tabMessageHandler(tabId, message, options);
      },
    },
    sidePanel: { async setPanelBehavior() {} },
  };
  const context = {
    AbortController,
    URL,
    clearTimeout,
    console,
    fetch: async () => { throw new Error('Unexpected network request'); },
    setTimeout,
    structuredClone,
    chrome,
    NavaConnectorEngine: connectorEngine,
    NavaWorkQueueEngine: workQueueEngine,
    NavaProgramCatalog: programCatalog,
    NavaRecertificationEngine: recertificationEngine,
  };
  context.globalThis = context;
  vm.createContext(context);
  SERVICE_WORKER_SCRIPTS.forEach((script) => {
    vm.runInContext(fs.readFileSync(path.join(root, script), 'utf8'), context, { filename: script });
  });
  const source = fs.readFileSync(path.join(root, 'background.js'), 'utf8')
    .replace(/^import .*;\s*$/gm, '');
  vm.runInContext(source, context, { filename: 'background.js' });

  return {
    local,
    session,
    removedListener,
    tabMessages,
    onTabMessage(handler) { tabMessageHandler = handler; },
    async waitForTabMessage(type) {
      const existing = tabMessages.find((entry) => entry.message?.type === type);
      if (existing) return existing;
      return new Promise((resolve) => {
        const wait = (entry) => {
          if (entry.message?.type === type) resolve(entry);
          else tabMessageWaiters.push(wait);
        };
        tabMessageWaiters.push(wait);
      });
    },
    send(message) {
      return new Promise((resolve, reject) => {
        try {
          const asyncResponse = messageListener(message, {}, resolve);
          if (asyncResponse !== true) setImmediate(() => resolve(undefined));
        } catch (error) {
          reject(error);
        }
      });
    },
    // Calls the listener exactly as Chrome does and records what it returned and every response it sent.
    dispatch(message) {
      const responses = [];
      const returned = messageListener(message, {}, (response) => responses.push(clone(response)));
      return { returned, responses };
    },
  };
}

async function settle(turns = 20) {
  for (let turn = 0; turn < turns; turn += 1) await new Promise((resolve) => setImmediate(resolve));
}

async function waitForResponses(responses, count = 1) {
  for (let turn = 0; turn < 500 && responses.length < count; turn += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  return responses;
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function application(updatedAt = '2026-09-17T12:00:00.000Z') {
  return {
    id: 'workflow:test',
    name: 'Test application',
    queueLabel: 'Test application',
    workflowId: 'benefitscal',
    programIds: ['calfresh'],
    allowedOrigins: ['https://benefitscal.com'],
    allowedPathPrefixes: ['/ApplyForBenefits/'],
    url: 'https://benefitscal.com/ApplyForBenefits/ABNMI',
    tabId: 42,
    status: 'ready_to_fill',
    autoRun: true,
    updatedAt,
  };
}

async function claim(harness, state, participant = { firstName: 'Fictional' }, claimToken = 'participant:test') {
  return harness.send({
    type: 'CLAIM_CLIENT_SESSION',
    sessionEpoch: state.sessionEpoch,
    stateRevision: state.stateRevision,
    claimToken,
    participant,
  });
}

async function persist(harness, state, app, options = {}) {
  return harness.send({
    type: 'PERSIST_ASSISTANT_STATE',
    sessionEpoch: state.sessionEpoch,
    participantSessionId: state.participantSessionId,
    stateRevision: options.stateRevision ?? state.stateRevision,
    applicationGenerations: { [app.id]: options.generation ?? state.applicationGenerations?.[app.id] ?? 0 },
    applicationRevisions: { [app.id]: options.revision ?? state.applicationRevisions?.[app.id] ?? 0 },
    holder: options.holder,
    session: {
      participant: options.participant ?? { firstName: 'Ignored by persist' },
      apps: [app],
      currentAppId: app.id,
    },
    queue: workQueueEngine.buildQueue([app]),
  });
}

function leaseMessage(type, state, app, holder) {
  return {
    type,
    sessionEpoch: state.sessionEpoch,
    participantSessionId: state.participantSessionId,
    applicationId: app.id,
    applicationGeneration: state.applicationGenerations?.[app.id] ?? 0,
    applicationRevision: state.applicationRevisions?.[app.id] ?? 0,
    holder,
    leaseMs: 60_000,
  };
}

test('the harness runs every service-worker import, in background.js import order', () => {
  const source = fs.readFileSync(path.join(root, 'background.js'), 'utf8');
  const imports = [...source.matchAll(/^import\b.*$/gm)]
    .map(([line]) => line.match(/^import '\.\/([^']+)';$/)?.[1] ?? line);
  assert.deepEqual(imports, [...ENGINE_IMPORTS, ...SERVICE_WORKER_SCRIPTS]);
});

test('service-worker modules reach the coordinator only through injected dependencies', () => {
  SERVICE_WORKER_SCRIPTS.filter((script) => script.startsWith('background/')).forEach((script) => {
    const source = fs.readFileSync(path.join(root, script), 'utf8');
    assert.doesNotMatch(source, /globalThis\.Nava/, `${script} must not read another module's global`);
    assert.doesNotMatch(source, /coordinatorChain/, `${script} must not keep its own coordinator chain`);
  });
});

test('a client-session claim is exclusive and persist can never replace its participant', async () => {
  const harness = backgroundHarness();
  const initial = await harness.send({ type: 'GET_ASSISTANT_STATE' });
  const alice = { firstName: 'Alice', recordId: 'alice-1' };
  const bob = { firstName: 'Bob', recordId: 'bob-2' };

  const claimed = await claim(harness, initial, alice, 'participant:alice');
  assert.equal(claimed.ok, true);
  assert.equal(claimed.sessionEpoch, initial.sessionEpoch + 1);
  assert.equal(claimed.participantSessionId, 'participant:alice');

  const collision = await claim(harness, initial, bob, 'participant:bob');
  assert.equal(collision.ok, false);
  assert.equal(collision.code, 'CLIENT_SESSION_CLAIMED');

  const tokenReuse = await claim(harness, claimed, bob, 'participant:alice');
  assert.equal(tokenReuse.ok, false);
  assert.equal(tokenReuse.code, 'CLIENT_SESSION_CLAIMED');

  const retry = await claim(harness, claimed, alice, 'participant:alice');
  assert.equal(retry.ok, true);
  assert.equal(retry.idempotent, true);

  const app = application();
  const saved = await persist(harness, claimed, app, { participant: bob });
  assert.equal(saved.ok, true);
  assert.equal(saved.participantIgnored, true);
  const restored = await harness.send({ type: 'GET_ASSISTANT_STATE' });
  assert.deepEqual(restored.session.participant, alice);
  assert.equal(restored.participantSessionId, 'participant:alice');
});

test('participant updates require the claim token and a current state revision', async () => {
  const harness = backgroundHarness();
  const initial = await harness.send({ type: 'GET_ASSISTANT_STATE' });
  const claimed = await claim(harness, initial, { firstName: 'Alice' }, 'participant:alice');
  const updatedParticipant = { firstName: 'Alice', email: 'alice@example.test' };

  const updated = await harness.send({
    type: 'UPDATE_SESSION_PARTICIPANT',
    sessionEpoch: claimed.sessionEpoch,
    participantSessionId: claimed.participantSessionId,
    stateRevision: claimed.stateRevision,
    participant: updatedParticipant,
  });
  assert.equal(updated.ok, true);
  assert.equal(updated.updated, true);
  assert.equal(updated.stateRevision, claimed.stateRevision + 1);

  const staleRevision = await harness.send({
    type: 'UPDATE_SESSION_PARTICIPANT',
    sessionEpoch: claimed.sessionEpoch,
    participantSessionId: claimed.participantSessionId,
    stateRevision: claimed.stateRevision,
    participant: { ...updatedParticipant, phone: '555-0100' },
  });
  assert.equal(staleRevision.ok, false);
  assert.equal(staleRevision.code, 'STALE_STATE_REVISION');

  const wrongToken = await harness.send({
    type: 'UPDATE_SESSION_PARTICIPANT',
    sessionEpoch: updated.sessionEpoch,
    participantSessionId: 'participant:bob',
    stateRevision: updated.stateRevision,
    participant: { firstName: 'Bob' },
  });
  assert.equal(wrongToken.ok, false);
  assert.equal(wrongToken.code, 'PARTICIPANT_SESSION_MISMATCH');
});

test('a global revoke stops stale application snapshots from replacing the paused state', async () => {
  const harness = backgroundHarness();
  const initial = await harness.send({ type: 'GET_ASSISTANT_STATE' });
  const claimed = await claim(harness, initial);
  const app = application();
  const saved = await persist(harness, claimed, app);
  assert.equal(saved.ok, true);

  const revoked = await harness.send({
    type: 'REVOKE_APPLICATION_RUN',
    sessionEpoch: saved.sessionEpoch,
    participantSessionId: saved.participantSessionId,
    applicationId: app.id,
    applicationGeneration: saved.applicationGenerations[app.id],
    applicationRevision: saved.applicationRevisions[app.id],
  });
  assert.equal(revoked.ok, true);
  assert.equal(revoked.applicationGeneration, 1);
  assert.equal(revoked.applicationRevision, 2);

  const stale = await persist(
    harness,
    revoked,
    { ...app, status: 'ready_for_review', updatedAt: '2030-01-01T00:00:00.000Z' },
    { generation: 0, revision: 1 },
  );
  assert.equal(stale.ok, false);
  assert.equal(stale.code, 'STALE_APPLICATION_GENERATION');

  const restored = await harness.send({ type: 'GET_ASSISTANT_STATE' });
  assert.equal(restored.session.apps[0].status, 'paused');
  assert.equal(restored.session.apps[0].autoRun, false);
  assert.equal(restored.queue.applications[0].status, 'paused');
});

test('clear rejects stale epochs and late writers without erasing a newer client session', async () => {
  const harness = backgroundHarness();
  const initial = await harness.send({ type: 'GET_ASSISTANT_STATE' });
  const alice = await claim(harness, initial, { firstName: 'Alice' }, 'participant:alice');
  const app = application();
  const aliceSaved = await persist(harness, alice, app);

  const cleared = await harness.send({ type: 'CLEAR_ASSISTANT_STATE', sessionEpoch: aliceSaved.sessionEpoch });
  assert.equal(cleared.ok, true);
  assert.equal(cleared.sessionEpoch, aliceSaved.sessionEpoch + 1);

  const late = await persist(
    harness,
    aliceSaved,
    { ...app, updatedAt: '2030-01-01T00:00:00.000Z' },
  );
  assert.equal(late.ok, false);
  assert.equal(late.code, 'STALE_SESSION_EPOCH');

  const bob = await claim(harness, cleared, { firstName: 'Bob' }, 'participant:bob');
  const staleClear = await harness.send({ type: 'CLEAR_ASSISTANT_STATE', sessionEpoch: aliceSaved.sessionEpoch });
  assert.equal(staleClear.ok, false);
  assert.equal(staleClear.code, 'STALE_SESSION_EPOCH');

  const restored = await harness.send({ type: 'GET_ASSISTANT_STATE' });
  assert.deepEqual(restored.session.participant, { firstName: 'Bob' });
  assert.equal(restored.sessionEpoch, bob.sessionEpoch);
});

test('persist enforces state and application CAS plus the central lease holder', async () => {
  const harness = backgroundHarness();
  const initial = await harness.send({ type: 'GET_ASSISTANT_STATE' });
  const claimed = await claim(harness, initial);
  const app = application();
  const saved = await persist(harness, claimed, app);
  const acquired = await harness.send(leaseMessage('ACQUIRE_APPLICATION_LEASE', saved, app, 'window-a'));
  assert.equal(acquired.ok, true);

  const changed = { ...app, status: 'needs_attention', updatedAt: '2026-09-17T12:01:00.000Z' };
  const wrongHolder = await persist(harness, saved, changed, { holder: 'window-b' });
  assert.equal(wrongHolder.ok, false);
  assert.equal(wrongHolder.code, 'LEASE_HELD');

  const ownerWrite = await persist(harness, saved, changed, { holder: 'window-a' });
  assert.equal(ownerWrite.ok, true);
  assert.equal(ownerWrite.applicationRevisions[app.id], 2);
  assert.equal(ownerWrite.stateRevision, saved.stateRevision + 1);

  const staleApplication = await persist(
    harness,
    ownerWrite,
    { ...changed, status: 'ready_for_review', updatedAt: '2026-09-17T12:02:00.000Z' },
    { holder: 'window-a', revision: 1 },
  );
  assert.equal(staleApplication.ok, false);
  assert.equal(staleApplication.code, 'STALE_APPLICATION_REVISION');

  const staleState = await persist(
    harness,
    ownerWrite,
    { ...changed, status: 'paused', updatedAt: '2026-09-17T12:03:00.000Z' },
    { holder: 'window-a', stateRevision: saved.stateRevision },
  );
  assert.equal(staleState.ok, false);
  assert.equal(staleState.code, 'STALE_STATE_REVISION');
});

test('a participant change revokes every stored application and reports the affected ids', async () => {
  const harness = backgroundHarness();
  const initial = await harness.send({ type: 'GET_ASSISTANT_STATE' });
  const claimed = await claim(harness, initial, { firstName: 'Alice' }, 'participant:alice');
  const app = application();
  const saved = await persist(harness, claimed, app);

  const updated = await harness.send({
    type: 'UPDATE_SESSION_PARTICIPANT',
    sessionEpoch: saved.sessionEpoch,
    participantSessionId: saved.participantSessionId,
    stateRevision: saved.stateRevision,
    participant: { firstName: 'Alice', email: 'alice@example.test' },
  });
  assert.equal(updated.ok, true);
  assert.deepEqual(Array.from(updated.revokedApplicationIds), [app.id]);
  assert.equal(updated.applicationGenerations[app.id], 1);
  assert.equal(updated.applicationRevisions[app.id], 2);

  const restored = await harness.send({ type: 'GET_ASSISTANT_STATE' });
  assert.equal(restored.session.apps[0].status, 'paused');
  assert.equal(restored.session.apps[0].autoRun, false);
  assert.equal(restored.queue.applications[0].status, 'paused');
});

test('only the current lease holder can release an active application lease', async () => {
  const harness = backgroundHarness();
  const initial = await harness.send({ type: 'GET_ASSISTANT_STATE' });
  const claimed = await claim(harness, initial);
  const app = application();
  const saved = await persist(harness, claimed, app);
  const acquired = await harness.send(leaseMessage('ACQUIRE_APPLICATION_LEASE', saved, app, 'window-a'));
  assert.equal(acquired.ok, true);

  const rejected = await harness.send(leaseMessage('RELEASE_APPLICATION_LEASE', saved, app, 'window-b'));
  assert.equal(rejected.ok, false);
  assert.equal(rejected.code, 'LEASE_HELD');

  const released = await harness.send(leaseMessage('RELEASE_APPLICATION_LEASE', saved, app, 'window-a'));
  assert.equal(released.ok, true);
  assert.equal(released.lease, null);
});

test('application commands and revocation are linearized around dispatch', async () => {
  const harness = backgroundHarness();
  const initial = await harness.send({ type: 'GET_ASSISTANT_STATE' });
  const claimed = await claim(harness, initial);
  const app = application();
  const saved = await persist(harness, claimed, app);
  await harness.send(leaseMessage('ACQUIRE_APPLICATION_LEASE', saved, app, 'window-a'));

  const fill = deferred();
  harness.onTabMessage((_tabId, message) => message.type === 'NAVA_FILL' ? fill.promise : Promise.resolve({ ok: true }));
  const executeMessage = {
    type: 'EXECUTE_APPLICATION_COMMAND',
    sessionEpoch: saved.sessionEpoch,
    participantSessionId: saved.participantSessionId,
    applicationId: app.id,
    applicationGeneration: saved.applicationGenerations[app.id],
    applicationRevision: saved.applicationRevisions[app.id],
    holder: 'window-a',
    requireLease: true,
    tabId: app.tabId,
    documentId: 'document-1',
    command: {
      type: 'NAVA_FILL',
      assignments: [],
      routePolicy: { origins: ['https://benefitscal.com'], exactPaths: ['/ApplyForBenefits/ABNMI'] },
    },
  };

  const executing = harness.send(executeMessage);
  await harness.waitForTabMessage('NAVA_FILL');
  const revoked = await harness.send({
    type: 'REVOKE_APPLICATION_RUN',
    sessionEpoch: saved.sessionEpoch,
    participantSessionId: saved.participantSessionId,
    applicationId: app.id,
    applicationGeneration: saved.applicationGenerations[app.id],
    applicationRevision: saved.applicationRevisions[app.id],
  });
  assert.equal(revoked.ok, true);
  assert.ok(harness.tabMessages.some((entry) => entry.message.type === 'NAVA_CANCEL'));

  fill.resolve({ ok: true, verifiedCount: 0 });
  const executed = await executing;
  assert.equal(executed.ok, false);
  assert.equal(executed.dispatched, true);
  assert.equal(executed.code, 'STALE_APPLICATION_GENERATION');

  const fillCount = harness.tabMessages.filter((entry) => entry.message.type === 'NAVA_FILL').length;
  const blocked = await harness.send(executeMessage);
  assert.equal(blocked.ok, false);
  assert.equal(blocked.dispatched, false);
  assert.equal(blocked.code, 'STALE_APPLICATION_GENERATION');
  assert.equal(harness.tabMessages.filter((entry) => entry.message.type === 'NAVA_FILL').length, fillCount);
});

test('a partial sibling persist cannot change an in-flight application revision', async () => {
  const harness = backgroundHarness();
  const initial = await harness.send({ type: 'GET_ASSISTANT_STATE' });
  const claimed = await claim(harness, initial);
  const appA = { ...application(), id: 'workflow:a', tabId: 41, name: 'Application A', queueLabel: 'Application A' };
  const appB = { ...application(), id: 'workflow:b', tabId: 42, name: 'Application B', queueLabel: 'Application B' };
  const savedA = await persist(harness, claimed, appA);
  const savedBoth = await persist(harness, savedA, appB);
  await harness.send(leaseMessage('ACQUIRE_APPLICATION_LEASE', savedBoth, appB, 'window-b'));

  const fill = deferred();
  harness.onTabMessage((_tabId, message) => message.type === 'NAVA_FILL' ? fill.promise : Promise.resolve({ ok: true }));
  const executingB = harness.send({
    type: 'EXECUTE_APPLICATION_COMMAND',
    sessionEpoch: savedBoth.sessionEpoch,
    participantSessionId: savedBoth.participantSessionId,
    applicationId: appB.id,
    applicationGeneration: savedBoth.applicationGenerations[appB.id],
    applicationRevision: savedBoth.applicationRevisions[appB.id],
    holder: 'window-b',
    requireLease: true,
    tabId: appB.tabId,
    documentId: 'document-b',
    command: {
      type: 'NAVA_FILL',
      assignments: [],
      routePolicy: { origins: ['https://benefitscal.com'], exactPaths: ['/ApplyForBenefits/ABNMI'] },
    },
  });
  await harness.waitForTabMessage('NAVA_FILL');

  const changedA = { ...appA, status: 'needs_attention', updatedAt: '2026-09-17T12:05:00.000Z' };
  const savedSibling = await persist(harness, savedBoth, changedA);
  assert.equal(savedSibling.ok, true);
  assert.equal(savedSibling.applicationRevisions[appA.id], savedBoth.applicationRevisions[appA.id] + 1);
  assert.equal(savedSibling.applicationRevisions[appB.id], savedBoth.applicationRevisions[appB.id]);

  fill.resolve({ ok: true, results: [] });
  const completedB = await executingB;
  assert.equal(completedB.ok, true);
  assert.equal(completedB.applicationRevisions[appB.id], savedBoth.applicationRevisions[appB.id]);
});

test('closing a bound tab advances the application and state revisions', async () => {
  const harness = backgroundHarness();
  const initial = await harness.send({ type: 'GET_ASSISTANT_STATE' });
  const claimed = await claim(harness, initial);
  const app = application();
  const saved = await persist(harness, claimed, app);

  harness.removedListener(app.tabId);
  const restored = await harness.send({ type: 'GET_ASSISTANT_STATE' });
  assert.equal(restored.stateRevision, saved.stateRevision + 1);
  assert.equal(restored.applicationGenerations[app.id], 1);
  assert.equal(restored.applicationRevisions[app.id], 2);
  assert.equal(restored.session.apps[0].tabId, null);
  assert.equal(restored.session.apps[0].status, 'paused');
});

test('disconnecting a connector atomically expires connector-derived client data and runs', async () => {
  const harness = backgroundHarness();
  const initial = await harness.send({ type: 'GET_ASSISTANT_STATE' });
  const claimed = await claim(harness, initial, {
    firstName: 'Fictional',
    _connector: { provider: 'apricot360', organizationName: 'Test organization' },
  });
  const app = application();
  const saved = await persist(harness, claimed, app);

  const reset = await harness.send({ type: 'RESET_CONNECTOR', sessionEpoch: saved.sessionEpoch });
  assert.equal(reset.ok, true);
  assert.equal(reset.assistantInvalidated, true);
  assert.equal(reset.sessionEpoch, saved.sessionEpoch + 1);
  assert.equal(typeof reset.stateRevision, 'number');
  assert.equal(reset.participantSessionId, '');

  const restored = await harness.send({ type: 'GET_ASSISTANT_STATE' });
  assert.equal(restored.session.participant, null);
  assert.equal(restored.session.apps[0].status, 'source_expired');
  assert.equal(restored.session.apps[0].autoRun, false);
  assert.equal(restored.queue.applications[0].status, 'source_expired');
});

const LEASE_KEY = 'nava:application-leases';

function executeMessage(state, app, overrides = {}) {
  return {
    type: 'EXECUTE_APPLICATION_COMMAND',
    sessionEpoch: state.sessionEpoch,
    participantSessionId: state.participantSessionId,
    applicationId: app.id,
    applicationGeneration: state.applicationGenerations[app.id],
    applicationRevision: state.applicationRevisions[app.id],
    holder: 'window-a',
    tabId: app.tabId,
    documentId: 'document-1',
    command: {
      type: 'NAVA_FILL',
      assignments: [],
      routePolicy: { origins: ['https://benefitscal.com'], exactPaths: ['/ApplyForBenefits/ABNMI'] },
    },
    ...overrides,
  };
}

async function savedApplication(harness) {
  const initial = await harness.send({ type: 'GET_ASSISTANT_STATE' });
  const claimed = await claim(harness, initial);
  const app = application();
  const saved = await persist(harness, claimed, app);
  return { app, saved };
}

test('unknown message types, including the removed GET_PROGRAMS, are never answered', async () => {
  const harness = backgroundHarness();
  const unknown = [undefined, null, {}, { type: 'GET_PROGRAMS' }, { type: 'NAVA_FILL' }, { type: 'get_assistant_state' }];
  for (const message of unknown) {
    const { returned, responses } = harness.dispatch(message);
    assert.equal(returned, false, `${JSON.stringify(message)} must not hold the response channel open`);
    await settle();
    assert.deepEqual(responses, [], `${JSON.stringify(message)} must not be answered`);
  }
});

test('every routed message type answers exactly once and holds the channel open for its async response', async () => {
  const harness = backgroundHarness();
  const routedTypes = [
    'GET_ASSISTANT_STATE',
    'CLAIM_CLIENT_SESSION',
    'UPDATE_SESSION_PARTICIPANT',
    'PERSIST_ASSISTANT_STATE',
    'CLEAR_ASSISTANT_STATE',
    'REVOKE_APPLICATION_RUN',
    'CHECK_APPLICATION_RUN',
    'EXECUTE_APPLICATION_COMMAND',
    'ACQUIRE_APPLICATION_LEASE',
    'RELEASE_APPLICATION_LEASE',
    'GET_CONNECTOR_STATUS',
    'DISCOVER_CONNECTOR',
    'SAVE_CONNECTOR',
    'RESET_CONNECTOR',
    'LIST_RECERTIFICATIONS',
    'OPEN_PROGRAMS',
  ];
  for (const type of routedTypes) {
    const { returned, responses } = harness.dispatch({ type });
    assert.equal(returned, true, `${type} should hold the response channel open`);
    await waitForResponses(responses);
    await settle();
    assert.equal(responses.length, 1, `${type} should answer exactly once`);
    assert.equal(typeof responses[0].ok, 'boolean', `${type} should answer with an ok flag`);
  }
});

test('record lookups reject a malformed ID synchronously and otherwise answer from the demo connector', async () => {
  const harness = backgroundHarness();
  const invalid = harness.dispatch({ type: 'LOOKUP_RECORD', recordId: '../339619' });
  assert.equal(invalid.returned, false);
  assert.deepEqual(invalid.responses, [{ ok: false, record: null, message: 'Enter a valid client record ID.' }]);

  const found = harness.dispatch({ type: 'LOOKUP_RECORD', recordId: ' 339619 ' });
  assert.equal(found.returned, true);
  const [record] = await waitForResponses(found.responses);
  assert.equal(record.ok, true);
  assert.equal(record.record.record_id, '339619');
  assert.equal(record.provider, 'bundled-demo-records');
  assert.equal(record.message, 'Fictional demo record loaded.');

  const missing = await harness.send({ type: 'LOOKUP_RECORD', recordId: 'no-such-record' });
  assert.equal(missing.ok, false);
  assert.equal(missing.record, null);
  assert.match(missing.message, /No fictional record matched/);
});

test('connector status, recertifications, and program tabs fall back to bundled demo data', async () => {
  const harness = backgroundHarness();
  const status = await harness.send({ type: 'GET_CONNECTOR_STATUS' });
  assert.equal(status.ok, true);
  assert.equal(status.connector.mode, 'demo');

  const caseload = await harness.send({ type: 'LIST_RECERTIFICATIONS' });
  assert.equal(caseload.ok, true);
  assert.equal(caseload.source, 'fictional-demo');
  assert.equal(caseload.cases.length, 3);

  const opened = await harness.send({ type: 'OPEN_PROGRAMS', programs: ['calfresh', 'wic'] });
  assert.equal(opened.ok, true);
  assert.ok(opened.opened.length >= 1);
  assert.ok(opened.opened.every((workflow) => workflow.tabId === 100));

  const discovered = await harness.send({ type: 'DISCOVER_CONNECTOR', config: {} });
  assert.equal(discovered.ok, false);
  assert.equal(typeof discovered.error, 'string');
});

test('persisting an unchanged snapshot writes nothing and keeps every revision', async () => {
  const harness = backgroundHarness();
  const { app, saved } = await savedApplication(harness);

  const unchanged = await persist(harness, saved, app);
  assert.equal(unchanged.ok, true);
  assert.equal(unchanged.persisted, false);
  assert.deepEqual(Array.from(unchanged.changedApplicationIds), []);
  assert.equal(unchanged.stateRevision, saved.stateRevision);
  assert.equal(unchanged.applicationRevisions[app.id], saved.applicationRevisions[app.id]);
});

test('a current-application change alone advances the state revision but no application revision', async () => {
  const harness = backgroundHarness();
  const { app, saved } = await savedApplication(harness);

  const switched = await harness.send({
    type: 'PERSIST_ASSISTANT_STATE',
    sessionEpoch: saved.sessionEpoch,
    participantSessionId: saved.participantSessionId,
    stateRevision: saved.stateRevision,
    session: { apps: [], currentAppId: null },
    queue: { applications: [], audit: [] },
  });
  assert.equal(switched.ok, true);
  assert.equal(switched.persisted, true);
  assert.equal(switched.participantIgnored, false);
  assert.equal(switched.stateRevision, saved.stateRevision + 1);
  assert.equal(switched.applicationRevisions[app.id], saved.applicationRevisions[app.id]);

  const restored = await harness.send({ type: 'GET_ASSISTANT_STATE' });
  assert.equal(restored.session.currentAppId, null);
  assert.equal(restored.session.apps.length, 1);
  assert.equal(restored.queue.applications.length, 1);
});

test('persist drops an expired foreign lease while saving a changed application', async () => {
  const harness = backgroundHarness();
  const { app, saved } = await savedApplication(harness);
  harness.local.data[LEASE_KEY] = {
    [app.id]: { holder: 'window-b', acquiredAt: '2000-01-01T00:00:00.000Z', expiresAt: '2000-01-01T00:01:00.000Z' },
  };

  const changed = { ...app, status: 'needs_attention', updatedAt: '2026-09-17T12:01:00.000Z' };
  const written = await persist(harness, saved, changed, { holder: 'window-a' });
  assert.equal(written.ok, true);
  assert.equal(written.persisted, true);
  assert.deepEqual(Array.from(written.changedApplicationIds), [app.id]);
  assert.equal(harness.local.data[LEASE_KEY][app.id], undefined);
});

test('a claim after a connector reset re-binds stored applications as source-expired with fresh counters', async () => {
  const harness = backgroundHarness();
  const initial = await harness.send({ type: 'GET_ASSISTANT_STATE' });
  const connectorClient = { firstName: 'Fictional', _connector: { provider: 'apricot360' } };
  const claimed = await claim(harness, initial, connectorClient, 'participant:first');
  const app = application();
  const saved = await persist(harness, claimed, app);
  await harness.send(leaseMessage('ACQUIRE_APPLICATION_LEASE', saved, app, 'window-a'));
  const reset = await harness.send({ type: 'RESET_CONNECTOR', sessionEpoch: saved.sessionEpoch });
  assert.equal(reset.ok, true);

  const reclaimed = await claim(harness, reset, { firstName: 'Fictional' }, 'participant:second');
  assert.equal(reclaimed.ok, true);
  assert.equal(reclaimed.claimed, true);
  assert.equal(reclaimed.idempotent, false);
  assert.equal(reclaimed.participantSessionId, 'participant:second');
  assert.equal(reclaimed.sessionEpoch, reset.sessionEpoch + 1);
  assert.equal(reclaimed.stateRevision, reset.stateRevision + 1);
  assert.equal(reclaimed.applicationGenerations[app.id], 0);
  assert.equal(reclaimed.applicationRevisions[app.id], 0);
  assert.equal(harness.local.data[LEASE_KEY], undefined);

  const restored = await harness.send({ type: 'GET_ASSISTANT_STATE' });
  assert.deepEqual(restored.session.participant, { firstName: 'Fictional' });
  assert.equal(restored.session.currentAppId, null);
  assert.equal(restored.session.apps[0].status, 'source_expired');
  assert.equal(restored.session.apps[0].autoRun, false);
  assert.equal(restored.session.apps[0].checkpoint.label, 'Verify reloaded client data before resuming');
  assert.equal(restored.queue.applications[0].status, 'source_expired');
});

test('application commands are rejected before dispatch when the input, target, or lease is wrong', async () => {
  const harness = backgroundHarness();
  const { app, saved } = await savedApplication(harness);
  const fillCount = () => harness.tabMessages.filter((entry) => entry.message.type === 'NAVA_FILL').length;

  const wrongTab = await harness.send(executeMessage(saved, app, { tabId: 7 }));
  assert.equal(wrongTab.ok, false);
  assert.equal(wrongTab.stale, true);
  assert.equal(wrongTab.dispatched, false);
  assert.equal(wrongTab.code, 'APPLICATION_TAB_MISMATCH');

  const invalidInputs = [
    [{ tabId: -1 }, 'A valid application tab is required.'],
    [{ documentId: '' }, 'A bound application document is required.'],
    [{ command: { type: 'NAVA_SUBMIT', routePolicy: {} } }, 'Unsupported application command.'],
    [{ command: { type: 'NAVA_FILL', assignments: [] } }, 'The application command is missing its bound route policy.'],
  ];
  for (const [overrides, error] of invalidInputs) {
    const rejected = await harness.send(executeMessage(saved, app, overrides));
    assert.equal(rejected.ok, false);
    assert.equal(rejected.stale, false);
    assert.equal(rejected.dispatched, false);
    assert.equal(rejected.code, 'COORDINATOR_ERROR');
    assert.equal(rejected.error, error);
  }

  const withoutLease = await harness.send(executeMessage(saved, app));
  assert.equal(withoutLease.ok, false);
  assert.equal(withoutLease.dispatched, false);
  assert.equal(withoutLease.code, 'LEASE_LOST');
  assert.equal(fillCount(), 0);
});

test('a completed write command keeps the tab result, re-authorizes, and hands the lease back to the window', async () => {
  const harness = backgroundHarness();
  const { app, saved } = await savedApplication(harness);
  await harness.send(leaseMessage('ACQUIRE_APPLICATION_LEASE', saved, app, 'window-a'));
  harness.onTabMessage(async () => ({ ok: true, verifiedCount: 3 }));

  const done = await harness.send(executeMessage(saved, app));
  assert.equal(done.ok, true);
  assert.equal(done.verifiedCount, 3);
  assert.equal(done.dispatched, true);
  assert.equal(done.sessionEpoch, saved.sessionEpoch);
  assert.equal(done.applicationRevisions[app.id], saved.applicationRevisions[app.id]);
  const fill = harness.tabMessages.find((entry) => entry.message.type === 'NAVA_FILL');
  assert.equal(fill.tabId, app.tabId);
  assert.deepEqual(fill.options, { documentId: 'document-1' });
  const remaining = Date.parse(harness.local.data[LEASE_KEY][app.id].expiresAt) - Date.now();
  assert.ok(remaining > 60_000 && remaining <= 2 * 60 * 1000, 'the 10-minute command lease returns to the 2-minute active lease');
});

test('a rejected tab dispatch shortens the command lease and reports TAB_COMMAND_FAILED', async () => {
  const harness = backgroundHarness();
  const { app, saved } = await savedApplication(harness);
  await harness.send(leaseMessage('ACQUIRE_APPLICATION_LEASE', saved, app, 'window-a'));
  harness.onTabMessage(async () => { throw new Error('Receiving end does not exist.'); });

  const failed = await harness.send(executeMessage(saved, app));
  assert.equal(failed.ok, false);
  assert.equal(failed.dispatched, true);
  assert.equal(failed.stale, false);
  assert.equal(failed.code, 'TAB_COMMAND_FAILED');
  assert.equal(failed.error, 'Receiving end does not exist.');
  assert.equal(failed.sessionEpoch, saved.sessionEpoch);
  const lease = harness.local.data[LEASE_KEY][app.id];
  assert.equal(lease.holder, 'window-a');
  const remaining = Date.parse(lease.expiresAt) - Date.now();
  assert.ok(remaining > 60_000 && remaining <= 2 * 60 * 1000, 'the failed command lease is shortened, not left at 10 minutes');
});

test('run checks report current counters and require a live lease only when asked', async () => {
  const harness = backgroundHarness();
  const { app, saved } = await savedApplication(harness);

  const allowed = await harness.send(leaseMessage('CHECK_APPLICATION_RUN', saved, app, 'window-a'));
  assert.equal(allowed.ok, true);
  assert.equal(allowed.allowed, true);
  assert.equal(allowed.applicationGeneration, saved.applicationGenerations[app.id]);
  assert.equal(allowed.applicationRevision, saved.applicationRevisions[app.id]);

  const leaseRequired = { ...leaseMessage('CHECK_APPLICATION_RUN', saved, app, 'window-a'), requireLease: true };
  const lost = await harness.send(leaseRequired);
  assert.equal(lost.ok, false);
  assert.equal(lost.allowed, false);
  assert.equal(lost.stale, true);
  assert.equal(lost.code, 'LEASE_LOST');

  await harness.send(leaseMessage('ACQUIRE_APPLICATION_LEASE', saved, app, 'window-a'));
  const held = await harness.send(leaseRequired);
  assert.equal(held.ok, true);
  assert.equal(held.allowed, true);

  const otherWindow = await harness.send({ ...leaseRequired, holder: 'window-b' });
  assert.equal(otherWindow.ok, false);
  assert.equal(otherWindow.code, 'LEASE_LOST');
});
