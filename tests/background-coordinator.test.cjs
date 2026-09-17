const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const connectorEngine = require('../shared/connector-engine.js');
const workQueueEngine = require('../shared/work-queue-engine.js');
const programCatalog = require('../shared/program-catalog.js');

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
  };
  context.globalThis = context;
  const source = fs.readFileSync(path.join(root, 'background.js'), 'utf8')
    .replace(/^import .*;\s*$/gm, '');
  vm.runInNewContext(source, context, { filename: 'background.js' });

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
  };
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
