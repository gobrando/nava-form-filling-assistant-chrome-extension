const test = require('node:test');
const assert = require('node:assert/strict');

const pageScan = require('../sidepanel/page-scan.js');
const applicationRunner = require('../sidepanel/application-runner.js');
const scanAnalysis = require('../sidepanel/scan-analysis.js');
const policyRules = require('../sidepanel/application-policy.js');
const format = require('../sidepanel/panel-format.js');
const workQueueEngine = require('../shared/work-queue-engine.js');
const { PROGRAMS } = require('../shared/program-catalog.js');

const policy = policyRules.create({ programs: PROGRAMS, hostLabel: format.hostLabel });
const BASE = 'https://benefitscal.com/ApplyForBenefits';

function runCancelledError() {
  return Object.assign(new Error('The automated run was stopped.'), { name: 'RunCancelledError' });
}

function assertApplicationRun(application, runToken) {
  if (runToken?.cancelled) throw runCancelledError();
}

/** Mirrors the side panel's setCheckpoint closely enough to observe stop rules. */
function checkpointRecorder(log) {
  return (application, kind, label, status = 'paused') => {
    application.checkpoint = { kind, label };
    application.status = status;
    application.autoRun = false;
    log.push(`checkpoint:${kind}`);
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

// ---------------------------------------------------------------------------
// Page scan
// ---------------------------------------------------------------------------

function scanHarness({ apps = [], previewMode = true, reply, plan } = {}) {
  const log = [];
  const audits = [];
  const state = { apps, participant: { record_id: '339619' }, currentAppId: null, view: 'programs' };
  const scanner = pageScan.create({
    state,
    previewMode,
    engine: {
      buildAnalysis: (fields) => ({ assignments: [], gaps: [], observed: [], counts: { fields: fields.length, missing: 0 } }),
    },
    agentPlanner: {
      async plan(request) {
        log.push('plan');
        return plan ? plan(request) : { gaps: [], metadata: { runtime: 'test', usage: { prompts: 2 } } };
      },
    },
    scanAnalysis,
    scanRecord: scanAnalysis.create({
      signatureHash: workQueueEngine.signatureHash,
      hostLabel: format.hostLabel,
      provenanceForScan: format.provenanceForScan,
      urlOrigin: policyRules.urlOrigin,
      urlPath: policyRules.urlPath,
      commandLocation: policyRules.commandLocation,
    }),
    async sendToTab(tab, message, options) {
      log.push(`send:${message.type}`);
      return reply ? reply(message, options) : {
        ok: true,
        page: { url: tab.url, title: 'Step' },
        fields: [{ fieldKey: 'a' }],
        analysis: { assignments: [{ fieldKey: 'a' }], gaps: [], observed: [], counts: { fields: 1 } },
        navigationGate: { kind: 'next', pageSignature: 'sig' },
        options,
      };
    },
    assertApprovedApplicationLocation(application, url) {
      log.push('approve');
      policy.assertApprovedApplicationLocation(application, url);
    },
    attachApplicationPolicy: policy.attachApplicationPolicy,
    urlPath: policyRules.urlPath,
    commandLocation: policyRules.commandLocation,
    checkpointFromScan: policyRules.checkpointFromScan,
    assertApplicationRun(application, runToken) {
      log.push('assert-run');
      assertApplicationRun(application, runToken);
    },
    cancelApplicationRun: (application) => log.push(`cancel:${application.id}`),
    assertUiGeneration: () => {},
    setCheckpoint: checkpointRecorder(log),
    recordAudit: (type, application, details) => audits.push({ type, details }),
    async persist(options) {
      log.push('persist');
      audits.push({ type: 'persist', details: options });
    },
    newWorkflowId: () => 'workflow:new',
    setBusy: () => {},
    setApplicationProgress: () => {},
    agentProgressMessage: () => '',
    prepareAgentRuntime: async () => log.push('prepare'),
    mergeVerifiedProvenance: format.mergeVerifiedProvenance,
    mergeAgenticMetadata: format.mergeAgenticMetadata,
  });
  return { ...scanner, log, audits, state };
}

function knownApplication(overrides = {}) {
  return policy.attachApplicationPolicy({
    id: 'workflow:benefits',
    name: 'CalFresh',
    tabId: 7,
    workflowId: 'benefitscal',
    url: `${BASE}/step-1`,
    ...overrides,
  });
}

test('a requested application is approved for its location before NAVA_SCAN carries client data', async () => {
  const offSite = scanHarness({ apps: [knownApplication()] });
  await assert.rejects(
    offSite.scanTab({ id: 7, url: 'https://evil.example/ApplyForBenefits/step-1' }, { quiet: true, applicationId: 'workflow:benefits' }),
    /left its approved site/,
  );
  assert.deepEqual(offSite.log, ['approve'], 'no scan command is sent after a failed approval');

  const approved = scanHarness({ apps: [knownApplication()] });
  const runToken = { cancelled: false };
  const stored = await approved.scanTab({ id: 7, url: `${BASE}/step-1` }, { quiet: true, applicationId: 'workflow:benefits', runToken });
  assert.deepEqual(approved.log.slice(0, 3), ['approve', 'assert-run', 'send:NAVA_SCAN']);
  assert.equal(approved.log.at(-1), 'persist');
  assert.equal(stored.id, 'workflow:benefits');
  assert.equal(stored.status, 'ready_to_fill');
  assert.equal(approved.state.apps.length, 1, 'a rescanned application replaces its own entry');
  assert.equal(approved.state.apps[0], stored);
  assert.deepEqual(approved.audits.find((event) => event.type === 'persist').details, { applicationIds: ['workflow:benefits'], includeCurrentAppId: false });
  assert.equal(approved.audits[0].type, 'scan_completed');
});

test('a scan run under a token requires the write lease and stops when the token was revoked', async () => {
  const harness = scanHarness({
    apps: [knownApplication()],
    reply: (message, options) => {
      assert.equal(options.requireLease, true);
      assert.equal(options.application.id, 'workflow:benefits');
      return { ok: true, page: { url: `${BASE}/step-1` }, analysis: { gaps: [], counts: { fields: 1 } } };
    },
  });
  const runToken = { cancelled: false };
  await harness.scanTab({ id: 7, url: `${BASE}/step-1` }, { quiet: true, applicationId: 'workflow:benefits', runToken });

  runToken.cancelled = true;
  await assert.rejects(
    harness.scanTab({ id: 7, url: `${BASE}/step-1` }, { quiet: true, applicationId: 'workflow:benefits', runToken }),
    /automated run was stopped/,
  );
});

test('a tab-bound application whose page changed is detached before any client data is read', async () => {
  const detached = knownApplication({ tabId: 12, url: `${BASE}/step-1` });
  const harness = scanHarness({
    apps: [detached],
    reply: (message, options) => {
      assert.equal(options.application, null, 'the detached application is never bound to the scan');
      return { ok: true, page: { url: `${BASE}/step-2` }, analysis: { gaps: [], counts: { fields: 1 } }, navigationGate: { kind: 'next' } };
    },
  });
  const stored = await harness.scanTab({ id: 12, url: `${BASE}/step-2` }, { quiet: true });

  assert.deepEqual(harness.log.slice(0, 4), ['approve', 'cancel:workflow:benefits', 'checkpoint:page_changed', 'send:NAVA_SCAN']);
  assert.equal(detached.tabId, null);
  assert.equal(detached.status, 'paused');
  assert.match(detached.runStopReason, /detached before any client data was read or written/);
  assert.equal(stored.id, 'workflow:new');
  assert.equal(harness.state.apps[0], stored, 'a new scan is listed first');
});

test('a conditional-field rescan that lands on another location stops without storing anything', async () => {
  const harness = scanHarness({
    apps: [knownApplication()],
    reply: () => ({ ok: true, page: { url: `${BASE}/step-2` }, analysis: { gaps: [], counts: { fields: 1 } } }),
  });
  await assert.rejects(
    harness.scanTab({ id: 7, url: `${BASE}/step-1` }, {
      quiet: true,
      applicationId: 'workflow:benefits',
      expectedCommandLocation: `${BASE}/step-1`,
    }),
    /navigated while the assistant was checking for conditional fields/,
  );
  assert.equal(harness.log.includes('persist'), false);

  const failed = scanHarness({ apps: [knownApplication()], reply: () => ({ ok: false, error: 'No page agent.' }) });
  await assert.rejects(failed.scanTab({ id: 7, url: `${BASE}/step-1` }, { applicationId: 'workflow:benefits' }), /No page agent\./);
});

test('outside preview the agent plan is required, merged, and its usage audited', async () => {
  const missingInventory = scanHarness({
    previewMode: false,
    apps: [knownApplication()],
    reply: () => ({ ok: true, page: { url: `${BASE}/step-1` } }),
  });
  await assert.rejects(
    missingInventory.scanTab({ id: 7, url: `${BASE}/step-1` }, { quiet: true, applicationId: 'workflow:benefits' }),
    /did not provide a safe field inventory/,
  );
  assert.equal(missingInventory.log.includes('plan'), false);

  const planned = scanHarness({
    previewMode: false,
    apps: [knownApplication()],
    plan: () => ({ gaps: [{ fieldKey: 'extra', reason: 'Agent gap' }], metadata: { runtime: 'test', usage: { prompts: 4, inputTokens: 50 } } }),
    reply: () => ({
      ok: true,
      page: { url: `${BASE}/step-1` },
      fields: [{ fieldKey: 'extra', type: 'text', label: 'Extra' }],
      navigationGate: { kind: 'next', pageSignature: 'sig' },
    }),
  });
  const stored = await planned.scanTab({ id: 7, url: `${BASE}/step-1` }, { quiet: true, applicationId: 'workflow:benefits' });
  assert.deepEqual(
    planned.log.slice(0, 7),
    ['approve', 'assert-run', 'send:NAVA_SCAN', 'assert-run', 'approve', 'prepare', 'plan'],
    'the observed URL is re-approved before the page is planned',
  );
  assert.deepEqual(stored.analysis.gaps.map((gap) => gap.fieldKey), ['extra']);
  assert.equal(stored.status, 'needs_attention');
  assert.equal(stored.agentic.planCount, 1);
  const scanAudit = planned.audits.find((event) => event.type === 'scan_completed').details;
  assert.equal(scanAudit.modelPromptCount, 4);
  assert.equal(scanAudit.modelInputTokens, 50);
  assert.equal(scanAudit.checkpointKind, 'human_input');
  assert.ok(planned.audits.some((event) => event.type === 'questions_required'));
});

// ---------------------------------------------------------------------------
// Application runner
// ---------------------------------------------------------------------------

function page(number, overrides = {}) {
  return {
    url: `${BASE}/step-${number}`,
    gate: { kind: 'next', text: 'Next', pageSignature: `sig-${number}`, reason: 'A known safe “Next” control is ready.' },
    assignments: [{ fieldKey: `field-${number}`, label: `Field ${number}`, value: 'x' }],
    gaps: [],
    ...overrides,
  };
}

/** A simulated multi-page site: answers tab commands for the current page and builds scanned applications. */
function runnerHarness({ pages, application = {}, previewMode = true, state: stateOverrides = {}, onFill, rescan } = {}) {
  const log = [];
  const audits = [];
  const site = { index: 0 };
  const current = () => pages[site.index];
  const state = { apps: [], participant: { record_id: '339619' }, currentAppId: null, view: 'dashboard', previewPage: 1, ...stateOverrides };
  const scanned = (previous) => ({
    ...previous,
    url: current().url,
    page: { url: current().url, title: `Step ${site.index + 1}` },
    analysis: { assignments: current().assignments, gaps: current().gaps, observed: [] },
    navigationGate: current().gate,
    submitGate: current().submitGate,
  });
  let latest = scanned(policy.attachApplicationPolicy({
    id: 'workflow:benefits',
    name: 'CalFresh',
    tabId: 7,
    workflowId: 'benefitscal',
    url: pages[0].url,
    completedPages: [],
    visitedSignatures: [],
    ...application,
  }));
  state.apps.push(latest);

  const runner = applicationRunner.create({
    state,
    previewMode,
    workQueueEngine,
    scanAnalysis,
    MAX_SAME_PAGE_FILL_PASSES: 3,
    NAVIGATION_TIMEOUT_MS: 60_000,
    async sendToTab(tab, message, options) {
      log.push(`send:${message.type}`);
      assert.equal(options.application.id, 'workflow:benefits', 'every runner command is bound to its application');
      if (message.type === 'NAVA_FILL') {
        onFill?.(message);
        return {
          ok: true,
          results: message.assignments.map((item) => ({ ...item, status: current().blocked?.includes(item.fieldKey) ? 'blocked' : 'verified', reason: 'Needs direct entry.' })),
          provenance: [],
          navigationGate: current().gate,
          submitGate: current().submitGate,
        };
      }
      if (message.type === 'NAVA_NAVIGATION_STATUS') return { ok: true, navigationGate: current().gate };
      if (message.type === 'NAVA_ADVANCE') {
        if (current().advanceFails) return { ok: true, advanced: false, navigationGate: { reason: 'The Next control disappeared.' } };
        site.index += 1;
        return { ok: true, advanced: true };
      }
      if (message.type === 'NAVA_SCAN') return { ok: true, page: { url: current().url }, navigationGate: current().gate };
      return { ok: true };
    },
    async scanTab(tab, options) {
      log.push(options.expectedCommandLocation ? 'rescan' : 'scan');
      latest = rescan ? rescan(latest, options) : scanned(latest);
      return latest;
    },
    getActiveTab: async () => ({ id: 7, url: current().url }),
    assertApprovedApplicationLocation(target, url) {
      log.push('approve');
      policy.assertApprovedApplicationLocation(target, url);
    },
    assertSameDocumentLocation: policyRules.assertSameDocumentLocation,
    urlOrigin: policyRules.urlOrigin,
    urlPath: policyRules.urlPath,
    commandLocation: policyRules.commandLocation,
    automatedPageLimit: policyRules.automatedPageLimit,
    stopCheckpoint: policyRules.stopCheckpoint,
    pendingHumanCheck: policyRules.pendingHumanCheck,
    assertApplicationRun,
    runCancelledError,
    async renewApplicationLease(target, runToken) {
      assertApplicationRun(target, runToken);
      log.push('lease');
    },
    setCheckpoint: checkpointRecorder(log),
    recordAudit: (type, target, details) => audits.push({ type, details }),
    persist: async () => log.push('persist'),
    setBusy: () => {},
    setApplicationProgress: () => {},
    mergeVerifiedProvenance: format.mergeVerifiedProvenance,
  });
  return { ...runner, log, audits, state, site, application: () => latest, first: state.apps[0] };
}

const sends = (log, type) => log.filter((entry) => entry === `send:${type}`).length;

test('a run renews its lease every page, fills before it advances, and stops at final review without submitting', async () => {
  const final = page(3, { gate: { kind: 'final_review', text: 'Submit application', pageSignature: 'sig-3', reason: 'Submission stays with the caseworker.' } });
  const harness = runnerHarness({ pages: [page(1), page(2), final] });
  const runToken = { cancelled: false };
  await harness.runThroughApplication(harness.first, [], [], { runToken });

  const firstPage = harness.log.slice(0, harness.log.indexOf('scan') + 1);
  assert.deepEqual(firstPage, [
    'persist',
    'lease',
    'approve', 'send:NAVA_FILL', 'persist',
    'approve', 'send:NAVA_NAVIGATION_STATUS',
    'send:NAVA_ADVANCE', 'persist', 'scan',
  ]);
  assert.equal(harness.log.filter((entry) => entry === 'lease').length, 3, 'the lease is renewed on every page');
  assert.equal(sends(harness.log, 'NAVA_FILL'), 3);
  assert.equal(sends(harness.log, 'NAVA_ADVANCE'), 2);
  assert.equal(harness.log.some((entry) => /SUBMIT/.test(entry)), false);

  const stopped = harness.application();
  assert.equal(stopped.status, 'ready_for_review');
  assert.deepEqual(stopped.checkpoint, { kind: 'final_review', label: 'Human final review required' });
  assert.equal(stopped.runStopReason, 'Submission stays with the caseworker.');
  assert.deepEqual(stopped.visitedSignatures, ['sig-1', 'sig-2']);
  assert.deepEqual(stopped.completedPages.map((item) => item.signature), ['sig-1', 'sig-2']);
  assert.equal(harness.state.view, 'review');
  assert.equal(harness.state.currentAppId, 'workflow:benefits');
  assert.deepEqual(harness.audits.find((event) => event.type === 'review_reached').details, { checkpointKind: 'final_review', pageCount: 3, toStatus: 'ready_for_review' });
  assert.deepEqual(harness.audits.filter((event) => event.type === 'safe_advance').map((event) => event.details.pageCount), [1, 2]);
});

test('stop rule: no values to write but open questions sends the caseworker to the questions', async () => {
  const harness = runnerHarness({ pages: [page(1, { assignments: [], gaps: [{ fieldKey: 'income', label: 'Income' }] })] });
  await harness.runThroughApplication(harness.first);

  assert.equal(sends(harness.log, 'NAVA_FILL'), 0);
  assert.deepEqual(harness.first.checkpoint, { kind: 'human_input', label: 'Caseworker answers required' });
  assert.equal(harness.first.status, 'needs_attention');
  assert.equal(harness.state.view, 'questions');
  assert.equal(harness.state.currentAppId, 'workflow:benefits');
  assert.equal(harness.log.at(-1), 'persist');

  const background = runnerHarness({ pages: [page(1, { assignments: [], gaps: [{ fieldKey: 'income', label: 'Income' }] })] });
  await background.runThroughApplication(background.first, [], [], { background: true });
  assert.equal(background.state.view, 'dashboard', 'a background run never changes the screen');
});

test('caseworker answers are filled once with the page values, then the run continues', async () => {
  const final = page(2, { gate: { kind: 'final_review', text: 'Review', pageSignature: 'sig-2' } });
  const fills = [];
  const harness = runnerHarness({
    pages: [page(1, { gaps: [{ fieldKey: 'income', label: 'Income' }] }), final],
    onFill: (message) => fills.push(message.assignments.map((item) => item.fieldKey)),
  });
  await harness.runThroughApplication(harness.first, [{ fieldKey: 'income', value: '1850' }], [], { background: true });
  assert.deepEqual(fills, [['field-1', 'income'], ['field-2']]);
  assert.deepEqual(harness.first.empty, [], 'answered gaps are no longer reported as empty');
});

test('stop rule: a blocked field after the fill pauses before reading the continuation control', async () => {
  const harness = runnerHarness({ pages: [page(1, { blocked: ['field-1'] }), page(2)] });
  await harness.runThroughApplication(harness.first);

  assert.equal(sends(harness.log, 'NAVA_NAVIGATION_STATUS'), 0);
  assert.equal(sends(harness.log, 'NAVA_ADVANCE'), 0);
  assert.deepEqual(harness.first.checkpoint, { kind: 'direct_entry', label: 'Direct caseworker entry required' });
  assert.match(harness.first.runStopReason, /paused after filling the known values/);
  assert.deepEqual(harness.first.empty, [{ label: 'Field 1', reason: 'Needs direct entry.' }]);
  assert.equal(harness.state.view, 'dashboard');
});

test('stop rule: conditional fields that keep appearing stop after the same-page pass limit', async () => {
  let rescans = 0;
  const harness = runnerHarness({
    previewMode: false,
    pages: [page(1), page(2)],
    rescan: (previous, options) => {
      rescans += 1;
      assert.equal(options.preservePageProgress, true);
      assert.equal(options.expectedCommandLocation, `${BASE}/step-1`);
      return { ...previous, analysis: { assignments: [{ fieldKey: `conditional-${rescans}`, value: 'y' }], gaps: [], observed: [] } };
    },
  });
  const chrome = { tabs: { get: async (tabId) => ({ id: tabId, url: `${BASE}/step-1`, status: 'complete' }) } };
  await withChrome(chrome, () => harness.runThroughApplication(harness.first, [], [], { background: true }));

  assert.equal(sends(harness.log, 'NAVA_FILL'), 3);
  assert.equal(harness.log.filter((entry) => entry === 'lease').length, 3);
  assert.equal(sends(harness.log, 'NAVA_NAVIGATION_STATUS'), 0);
  const stopped = harness.application();
  assert.deepEqual(stopped.checkpoint, { kind: 'navigation_unknown', label: 'Conditional fields require review' });
  assert.match(stopped.error, /revealed more fields after 3 verified fill passes\. The assistant stopped before advancing\./);
  assert.equal(stopped.autoRun, false);
});

test('a conditional-field rescan refuses a tab that moved to another document', async () => {
  const harness = runnerHarness({ previewMode: false, pages: [page(1), page(2)] });
  const chrome = { tabs: { get: async (tabId) => ({ id: tabId, url: `${BASE}/step-1#elsewhere`, status: 'complete' }) } };
  await assert.rejects(
    withChrome(chrome, () => harness.runThroughApplication(harness.first, [], [], { background: true })),
    /navigated before the assistant could safely read or write it/,
  );
  assert.equal(harness.log.includes('rescan'), false);
  assert.equal(sends(harness.log, 'NAVA_NAVIGATION_STATUS'), 0);
});

test('stop rule: a gate other than next stops for the caseworker, and signature gates go to review', async () => {
  const manual = runnerHarness({ pages: [page(1, { gate: { kind: 'manual', text: 'Upload', pageSignature: 'sig-1' } })] });
  await manual.runThroughApplication(manual.first);
  assert.deepEqual(manual.first.checkpoint, { kind: 'navigation_unknown', label: 'Caseworker action required' });
  assert.equal(manual.first.status, 'needs_attention');
  assert.match(manual.first.runStopReason, /No approved continuation control is visible/);
  assert.equal(manual.state.view, 'dashboard');
  assert.equal(manual.audits.some((event) => event.type === 'review_reached'), false);

  const captcha = runnerHarness({ pages: [page(1, { gate: { kind: 'none', pageSignature: 'sig-1' }, submitGate: { botCheckPresent: true, botCheckComplete: false } })] });
  await captcha.runThroughApplication(captcha.first);
  assert.equal(captcha.first.checkpoint.kind, 'captcha');

  const signature = runnerHarness({ pages: [page(1, { gate: { kind: 'final_review', text: 'Sign and submit', pageSignature: 'sig-1' } })] });
  await signature.runThroughApplication(signature.first);
  assert.deepEqual(signature.first.checkpoint, { kind: 'signature', label: 'Human final review required' });
  assert.equal(signature.first.status, 'ready_for_review');
  assert.equal(signature.state.view, 'review');
  assert.equal(sends(signature.log, 'NAVA_ADVANCE'), 0);
});

test('stop rule: the playbook page limit stops before the last allowed advance', async () => {
  const completedPages = Array.from({ length: 59 }, (_, index) => ({ signature: `done-${index}` }));
  const atLimit = runnerHarness({ pages: [page(1), page(2)], application: { completedPages } });
  await atLimit.runThroughApplication(atLimit.first);
  assert.equal(sends(atLimit.log, 'NAVA_ADVANCE'), 0);
  assert.deepEqual(atLimit.first.checkpoint, { kind: 'navigation_unknown', label: 'Automation page limit reached' });
  assert.match(atLimit.first.error, /reached this playbook’s 60-page safety limit/);

  const belowLimit = runnerHarness({
    pages: [page(1), page(2, { gate: { kind: 'final_review', text: 'Review', pageSignature: 'sig-2' } })],
    application: { completedPages: completedPages.slice(1) },
  });
  await belowLimit.runThroughApplication(belowLimit.first);
  assert.equal(sends(belowLimit.log, 'NAVA_ADVANCE'), 1);
});

test('stop rule: a page signature the run already completed stops a navigation loop', async () => {
  const harness = runnerHarness({ pages: [page(1), page(2)], application: { visitedSignatures: ['sig-1'] } });
  await harness.runThroughApplication(harness.first);
  assert.equal(sends(harness.log, 'NAVA_ADVANCE'), 0);
  assert.deepEqual(harness.first.checkpoint, { kind: 'page_changed', label: 'Repeated application page detected' });
  assert.match(harness.first.error, /avoid a navigation loop/);
});

test('a refused advance and a revoked run token both stop the run without another command', async () => {
  const refused = runnerHarness({ pages: [page(1, { advanceFails: true }), page(2)] });
  await assert.rejects(refused.runThroughApplication(refused.first), /The Next control disappeared\./);
  assert.equal(refused.log.includes('scan'), false);

  const runToken = { cancelled: false };
  const revoked = runnerHarness({ pages: [page(1), page(2)], onFill: () => { runToken.cancelled = true; } });
  await assert.rejects(revoked.runThroughApplication(revoked.first, [], [], { runToken }), { name: 'RunCancelledError' });
  assert.equal(sends(revoked.log, 'NAVA_NAVIGATION_STATUS'), 0);
  assert.equal(sends(revoked.log, 'NAVA_ADVANCE'), 0);
});

test('a single-page fill labels final steps for human review and never advances', async () => {
  const harness = runnerHarness({ pages: [page(1, { gate: { kind: 'final_review', text: 'Certify', reason: 'Affirm the declaration', pageSignature: 'sig-1' } })] });
  await harness.fillApplication(harness.first);
  assert.deepEqual(harness.first.checkpoint, { kind: 'certification', label: 'Human review required' });
  assert.equal(harness.first.status, 'ready_for_review');
  assert.equal(harness.first.autoRun, false);
  assert.equal(harness.first.runStopReason, 'Affirm the declaration');
  assert.equal(harness.state.view, 'review');
  assert.equal(sends(harness.log, 'NAVA_NAVIGATION_STATUS'), 0);
  assert.equal(sends(harness.log, 'NAVA_ADVANCE'), 0);

  const unanswered = runnerHarness({ pages: [page(1)] });
  await unanswered.fillApplication(unanswered.first, [], [{ label: 'Income' }]);
  assert.equal(unanswered.first.status, 'needs_attention');
  assert.equal(unanswered.state.view, 'dashboard');
});

test('resuming a human checkpoint waits for the CAPTCHA or code, then continues the run', async () => {
  const pending = runnerHarness({ pages: [page(1, { submitGate: { botCheckPresent: true, botCheckComplete: false } })] });
  pending.first.checkpoint = { kind: 'captcha' };
  const still = await pending.resumeHumanCheckpoint(pending.first);
  assert.deepEqual(still.checkpoint, { kind: 'captcha', label: 'Human CAPTCHA still required' });
  assert.match(still.error, /Complete the CAPTCHA in the application tab/);
  assert.equal(sends(pending.log, 'NAVA_FILL'), 0);

  const code = runnerHarness({ pages: [page(1, { submitGate: { oneTimeCodePresent: true, oneTimeCodeComplete: false, botCheckPresent: true } })] });
  const codeStop = await code.resumeHumanCheckpoint(code.first);
  assert.deepEqual(codeStop.checkpoint, { kind: 'otp', label: 'One-time code still required' });

  const done = runnerHarness({ pages: [page(1, { gate: { kind: 'final_review', text: 'Review', pageSignature: 'sig-1' } })] });
  done.first.checkpoint = { kind: 'captcha' };
  await done.resumeHumanCheckpoint(done.first);
  assert.deepEqual(done.audits.find((event) => event.type === 'checkpoint_completed').details, { checkpointKind: 'captcha', toStatus: undefined });
  assert.equal(sends(done.log, 'NAVA_FILL'), 1, 'the run resumes and fills the page');
});

test('a human checkpoint on a page that moved is paused instead of rescanned', async () => {
  const harness = runnerHarness({ previewMode: false, pages: [page(1), page(2)] });
  const chrome = { tabs: { get: async (tabId) => ({ id: tabId, url: `${BASE}/step-2`, status: 'complete' }) } };
  const paused = await withChrome(chrome, () => harness.resumeHumanCheckpoint(harness.first));
  assert.deepEqual(paused.checkpoint, { kind: 'page_changed', label: 'Application page changed' });
  assert.equal(harness.log.includes('rescan'), false);
});

test('resuming verifies the saved location before the resume decision reads the page', async () => {
  const moved = runnerHarness({
    pages: [page(1)],
    application: { resumePoint: { commandLocationHash: workQueueEngine.signatureHash(`${BASE}/step-9`) } },
  });
  const rejected = await moved.resumeApplication(moved.first);
  assert.equal(rejected.status, 'paused');
  assert.equal(rejected.error, 'The application query or page state changed since it was paused.');
  assert.deepEqual(moved.audits.find((event) => event.type === 'resume_rejected').details, { resumeOutcome: 'location_changed', checkpointKind: 'page_changed', toStatus: 'paused' });
  assert.equal(sends(moved.log, 'NAVA_SCAN'), 0, 'no client data is sent to an unverified tab');

  const noSource = runnerHarness({ pages: [page(1)], state: { participant: null } });
  const expired = await noSource.resumeApplication(noSource.first);
  assert.equal(expired.status, 'source_expired');
  assert.equal(sends(noSource.log, 'NAVA_SCAN'), 0);

  const verified = runnerHarness({
    pages: [page(1)],
    application: { resumePoint: { location: `${BASE}/step-1`, pageSignatureHash: workQueueEngine.signatureHash('sig-1') } },
  });
  const resumed = await verified.resumeApplication(verified.first);
  assert.deepEqual(verified.log.slice(0, 3), ['approve', 'send:NAVA_SCAN', 'scan']);
  assert.equal(resumed.error, '');
  assert.equal(verified.audits.at(-1).type, 'resume_verified');
  assert.equal(verified.state.currentAppId, 'workflow:benefits');
});
