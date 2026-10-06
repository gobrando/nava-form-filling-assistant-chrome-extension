const test = require('node:test');
const assert = require('node:assert/strict');

const messaging = require('../sidepanel/extension-messaging.js');
const policyRules = require('../sidepanel/application-policy.js');
const { hostLabel } = require('../sidepanel/panel-format.js');
const { PROGRAMS } = require('../shared/program-catalog.js');

const policy = policyRules.create({ programs: PROGRAMS, hostLabel });
const APPLICATION_URL = 'https://benefitscal.com/ApplyForBenefits/step-2?b=2&a=1';

/** A fake chrome.tabs / chrome.scripting pair that records every call. */
function fakeChrome({ pongs = [], documentId = 'doc-7', probeUrl = APPLICATION_URL, tabReply = { ok: true } } = {}) {
  const calls = [];
  const replies = [...pongs];
  return {
    calls,
    tabs: {
      async sendMessage(tabId, message, options) {
        calls.push({ api: 'tabs.sendMessage', tabId, message, options });
        if (message.type !== 'NAVA_PING') return tabReply;
        const reply = replies.length ? replies.shift() : null;
        if (reply instanceof Error) throw reply;
        return reply;
      },
    },
    scripting: {
      async executeScript(details) {
        calls.push({ api: 'scripting.executeScript', details });
        if (details.func) return [{ documentId, result: { url: probeUrl } }];
        return [];
      },
    },
  };
}

function withChrome(fake, action) {
  const previous = globalThis.chrome;
  globalThis.chrome = fake;
  return Promise.resolve().then(action).finally(() => {
    if (previous === undefined) delete globalThis.chrome;
    else globalThis.chrome = previous;
  });
}

function create(overrides = {}) {
  const log = { runtime: [], stale: [] };
  const api = messaging.create({
    previewMode: false,
    state: { sessionEpoch: 4, participantSessionId: 'session-1', workerId: 'worker-1' },
    async sendRuntime(message) {
      log.runtime.push(message);
      return overrides.runtimeReply || { ok: true };
    },
    previewTabMessage: async (message) => ({ ok: true, preview: message.type }),
    onStaleCommand: (application) => log.stale.push(application.id),
    coordinatorStaleError: (message) => Object.assign(new Error(message || 'stale'), { name: 'RunCancelledError' }),
    assertApprovedApplicationLocation: policy.assertApprovedApplicationLocation,
    assertSameDocumentLocation: policyRules.assertSameDocumentLocation,
    urlOrigin: policyRules.urlOrigin,
    urlPath: policyRules.urlPath,
    urlSearch: policyRules.urlSearch,
    urlHash: policyRules.urlHash,
    ...overrides,
  });
  return { api, log };
}

const ready = { ok: true, agentVersion: messaging.PAGE_AGENT_VERSION, adaptersReady: true };
const tab = { id: 12, url: APPLICATION_URL };

test('a stale page agent is replaced in the bound document, engine and adapters before the agent', async () => {
  const fake = fakeChrome({ pongs: [{ ok: true, agentVersion: 5, adaptersReady: true }, ready] });
  const { api } = create();
  await withChrome(fake, () => api.ensurePageAgent(tab, 'doc-7'));

  const injection = fake.calls.find((call) => call.api === 'scripting.executeScript');
  assert.deepEqual(injection.details.target, { tabId: 12, documentIds: ['doc-7'] });
  assert.deepEqual(injection.details.files, ['shared/form-engine.js', 'shared/site-adapters.js', 'content/form-agent.js']);
  const pings = fake.calls.filter((call) => call.message?.type === 'NAVA_PING');
  assert.equal(pings.length, 2);
  pings.forEach((ping) => assert.deepEqual(ping.options, { documentId: 'doc-7' }));
});

test('a current page agent is reused, and an unreachable one is injected tab-wide', async () => {
  const current = fakeChrome({ pongs: [ready] });
  await withChrome(current, () => create().api.ensurePageAgent(tab));
  assert.equal(current.calls.some((call) => call.api === 'scripting.executeScript'), false);
  assert.equal(current.calls[0].options, undefined);

  const missing = fakeChrome({ pongs: [new Error('Receiving end does not exist'), ready] });
  await withChrome(missing, () => create().api.ensurePageAgent(tab));
  assert.deepEqual(missing.calls.find((call) => call.api === 'scripting.executeScript').details.target, { tabId: 12 });
});

test('a version mismatch after injection stops with refresh guidance and no form writes', async () => {
  const fake = fakeChrome({ pongs: [null, { ok: true, agentVersion: 5, adaptersReady: true }] });
  await assert.rejects(
    withChrome(fake, () => create().api.ensurePageAgent(tab, 'doc-7')),
    /older form-filling agent\. Refresh this tab once.*No form values were changed\./,
  );
  const unready = fakeChrome({ pongs: [null, { ok: true, agentVersion: messaging.PAGE_AGENT_VERSION, adaptersReady: false }] });
  await assert.rejects(withChrome(unready, () => create().api.ensurePageAgent(tab)), /older form-filling agent/);
  await assert.rejects(
    withChrome(fakeChrome(), () => create().api.ensurePageAgent({ id: 3, url: 'chrome://extensions' })),
    /Chrome system pages cannot be filled/,
  );
});

test('application commands are bound to the probed document and routed through the service worker', async () => {
  const fake = fakeChrome({ pongs: [ready] });
  const { api, log } = create({ runtimeReply: { ok: true, filled: 2 } });
  const application = policy.attachApplicationPolicy({ id: 'workflow:1', url: 'https://benefitscal.com/ApplyForBenefits/begin', controlGeneration: 3, controlRevision: 9 });
  const response = await withChrome(fake, () => api.sendToTab(tab, { type: 'NAVA_FILL', assignments: [] }, { application, requireLease: true }));

  assert.deepEqual(response, { ok: true, filled: 2 });
  const [command] = log.runtime;
  assert.equal(command.type, 'EXECUTE_APPLICATION_COMMAND');
  assert.equal(command.tabId, 12);
  assert.equal(command.documentId, 'doc-7');
  assert.equal(command.sessionEpoch, 4);
  assert.equal(command.participantSessionId, 'session-1');
  assert.equal(command.holder, 'worker-1');
  assert.equal(command.applicationGeneration, 3);
  assert.equal(command.applicationRevision, 9);
  assert.equal(command.requireLease, true);
  assert.deepEqual(command.command.routePolicy, {
    origins: ['https://benefitscal.com'],
    pathPrefixes: ['/ApplyForBenefits/'],
    expectedPath: '/ApplyForBenefits/step-2',
    expectedSearch: '?a=1&b=2',
    expectedHash: '',
  });
  assert.equal(fake.calls.filter((call) => call.api === 'tabs.sendMessage' && call.message.type !== 'NAVA_PING').length, 0);
});

test('a one-off scan is sent straight to the bound document with an exact-path policy', async () => {
  const fake = fakeChrome({ pongs: [ready], tabReply: { ok: true, scanned: true } });
  const { api, log } = create();
  const response = await withChrome(fake, () => api.sendToTab(tab, { type: 'NAVA_SCAN' }));
  assert.deepEqual(response, { ok: true, scanned: true });
  assert.equal(log.runtime.length, 0);
  const scan = fake.calls.find((call) => call.message?.type === 'NAVA_SCAN');
  assert.deepEqual(scan.options, { documentId: 'doc-7' });
  assert.deepEqual(scan.message.routePolicy.origins, ['https://benefitscal.com']);
  assert.deepEqual(scan.message.routePolicy.exactPaths, ['/ApplyForBenefits/step-2']);
});

test('navigation, unapproved routes, and stale coordinators stop before or after the command', async () => {
  const moved = fakeChrome({ probeUrl: 'https://benefitscal.com/ApplyForBenefits/step-3' });
  await assert.rejects(withChrome(moved, () => create().api.sendToTab(tab, { type: 'NAVA_SCAN' })), /navigated before the assistant/);
  assert.equal(moved.calls.some((call) => call.message?.type === 'NAVA_SCAN'), false);

  const offsite = { id: 12, url: 'https://evil.example/ApplyForBenefits/step-2' };
  const elsewhere = fakeChrome({ probeUrl: offsite.url });
  const application = policy.attachApplicationPolicy({ id: 'workflow:1', name: 'CalFresh', url: 'https://benefitscal.com/ApplyForBenefits/begin' });
  const blocked = create();
  await assert.rejects(withChrome(elsewhere, () => blocked.api.sendToTab(offsite, { type: 'NAVA_FILL' }, { application })), /CalFresh tab left its approved site/);
  assert.equal(blocked.log.runtime.length, 0);

  const stale = create({ runtimeReply: { ok: false, stale: true, error: 'Changed in another window.' } });
  await assert.rejects(
    withChrome(fakeChrome({ pongs: [ready] }), () => stale.api.sendToTab(tab, { type: 'NAVA_FILL' }, { application })),
    (error) => error.name === 'RunCancelledError' && error.message === 'Changed in another window.',
  );
  assert.deepEqual(stale.log.stale, ['workflow:1']);
});

test('preview mode never touches extension APIs and assistant state retries before failing', async () => {
  const { api } = create({ previewMode: true });
  await withChrome(undefined, async () => {
    assert.equal(await api.ensurePageAgent({ id: 1, url: 'chrome://newtab' }), undefined);
    assert.deepEqual(await api.sendToTab(tab, { type: 'NAVA_SCAN' }), { ok: true, preview: 'NAVA_SCAN' });
  });

  let attempts = 0;
  const waits = [];
  const restored = await api.requestAssistantState(async () => {
    attempts += 1;
    return attempts === 2 ? { ok: true, session: null } : { ok: false, error: 'Could not establish connection.' };
  }, async (milliseconds) => waits.push(milliseconds));
  assert.equal(restored.ok, true);
  assert.deepEqual(waits, [150]);
  await assert.rejects(api.requestAssistantState(async () => ({ ok: false, error: 'Quota exceeded' }), async () => {}), /^Error: Quota exceeded$/);
});
