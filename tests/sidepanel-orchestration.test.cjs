const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const panel = fs.readFileSync(path.join(root, 'sidepanel/sidepanel.js'), 'utf8');

function section(start, end) {
  const startIndex = panel.indexOf(start);
  const endIndex = panel.indexOf(end, startIndex + start.length);
  assert.notEqual(startIndex, -1, `missing section start: ${start}`);
  assert.notEqual(endIndex, -1, `missing section end: ${end}`);
  return panel.slice(startIndex, endIndex);
}

function provenanceHelpers() {
  const source = section('function mergeVerifiedProvenance', 'function formatTimestamp');
  const context = {};
  vm.runInNewContext(`${source}\nresult = { mergeVerifiedProvenance, provenanceForScan };`, context);
  return context.result;
}

function recoveryHelper() {
  const source = section('async function requestAssistantState', 'async function probeTabDocument');
  const context = {};
  vm.runInNewContext(`${source}\nresult = requestAssistantState;`, context);
  return context.result;
}

test('dynamic page-agent injection installs site adapters before the content agent', () => {
  const source = section('async function ensurePageAgent', 'async function sendToTab');
  const formEngine = source.indexOf("'shared/form-engine.js'");
  const siteAdapters = source.indexOf("'shared/site-adapters.js'");
  const contentAgent = source.indexOf("'content/form-agent.js'");

  assert.ok(formEngine >= 0);
  assert.ok(formEngine < siteAdapters);
  assert.ok(siteAdapters < contentAgent);
});

test('unanswered form fields outrank an always-present CAPTCHA checkpoint', () => {
  const source = section('function checkpointFromScan', 'function automatedPageLimit');
  const gaps = source.indexOf('response.analysis?.gaps?.length');
  const captcha = source.indexOf('response.submitGate?.botCheckPresent');

  assert.ok(gaps >= 0);
  assert.ok(gaps < captcha);
  assert.match(source, /checkpoint\('human_input', 'Caseworker answers required'\)/);
});

test('assistant-state recovery retries service-worker startup and gives reload guidance', async () => {
  const requestAssistantState = recoveryHelper();
  let attempts = 0;
  const restored = await requestAssistantState(async () => {
    attempts += 1;
    return attempts < 3 ? undefined : { ok: true, session: null, queue: null };
  }, async () => {});
  assert.equal(attempts, 3);
  assert.equal(restored.ok, true);

  await assert.rejects(
    requestAssistantState(async () => undefined, async () => {}),
    /Close and reopen the side panel.*checkpoints remain available.*client data must be reloaded/i,
  );
});

test('CAPTCHA checkpoints expose a human-complete-and-resume path', () => {
  const card = section('function applicationCard', 'function renderDashboard');
  const resume = section('async function resumeHumanCheckpoint', 'async function exportAuditLog');
  const clickHandler = section('async function onClick', 'async function onSubmit');

  assert.match(card, /resume-human-checkpoint/);
  assert.match(card, /I completed the \$\{challenge\} — resume/);
  assert.match(resume, /expectedCommandLocation: expectedLocation/);
  assert.match(resume, /botCheckPresent && !rescanned\.submitGate\?\.botCheckComplete/);
  assert.match(resume, /Complete the CAPTCHA in the application tab/);
  assert.match(resume, /await runThroughApplication\(rescanned/);
  assert.doesNotMatch(resume, /click\(|solve|bypass/i);
  assert.match(clickHandler, /action === 'resume-human-checkpoint'/);
});

test('automatic runs fill known assignments before pausing for unanswered fields', () => {
  const queued = section('async function runQueuedApplication', 'function eligibleAutomaticApplication');
  const eligible = section('function eligibleAutomaticApplication', 'function scheduleCoordinatorRetry');
  const runner = section('async function runThroughApplication', 'async function fillApplication');

  assert.match(queued, /application\.status === 'needs_attention' && hasKnownAssignments/);
  assert.match(eligible, /application\?\.status === 'needs_attention' && hasKnownAssignments/);
  assert.match(runner, /const unresolvedForFill = hasSuppliedAnswers \? suppliedUnresolved : scannedGaps/);
  assert.match(runner, /if \(!assignmentCount && unresolvedForFill\.length\)/);
  assert.match(runner, /await fillCurrentPage\(current, suppliedAssignments, unresolvedForFill/);
  assert.ok(
    runner.indexOf('await fillCurrentPage(current, suppliedAssignments, unresolvedForFill')
      < runner.indexOf('if (current.empty.length || current.blocked.length)'),
  );
  assert.match(runner, /paused after filling the known values/);
});

test('conditional same-page work is rescanned with a hard pass limit before advance', () => {
  const rescan = section('async function rescanCurrentPageAfterFill', 'async function runThroughApplication');
  const runner = section('async function runThroughApplication', 'async function fillApplication');

  assert.match(panel, /const MAX_SAME_PAGE_FILL_PASSES = 3/);
  assert.match(rescan, /assertApprovedApplicationLocation\(application, tab\.url\)/);
  assert.match(rescan, /assertSameDocumentLocation\(application\.page\?\.url \|\| application\.url, tab\.url\)/);
  assert.match(rescan, /applicationId: application\.id/);
  assert.match(rescan, /expectedCommandLocation: expectedLocation/);
  assert.match(rescan, /preservePageProgress: true/);
  assert.match(runner, /const hasConditionalWork = Boolean/);
  assert.match(runner, /samePageFillPasses >= MAX_SAME_PAGE_FILL_PASSES/);
  assert.match(runner, /stopped before advancing/);

  const fillIndex = runner.indexOf('await fillCurrentPage(');
  const rescanIndex = runner.indexOf('await rescanCurrentPageAfterFill(');
  const advanceIndex = runner.indexOf("type: 'NAVA_ADVANCE'");
  assert.ok(fillIndex >= 0 && fillIndex < rescanIndex);
  assert.ok(rescanIndex < advanceIndex);
});

test('zero-write scans retain observed evidence and conditional rescans merge it safely', () => {
  const { mergeVerifiedProvenance, provenanceForScan } = provenanceHelpers();
  const firstScan = provenanceForScan([], [{
    fieldKey: 'field:1:3',
    label: 'First name',
    value: 'Celeste',
    source: 'page',
  }], false);

  assert.deepEqual(JSON.parse(JSON.stringify(firstScan)), [{
    fieldKey: 'field:1:3',
    label: 'First name',
    value: 'Celeste',
    source: 'page',
  }]);

  const rescanned = provenanceForScan(firstScan, [{
    fieldKey: 'field:2:9',
    label: 'Conditional case number',
    value: 'MC-12345678',
    source: 'page',
    sensitive: true,
  }], true);

  assert.equal(rescanned.length, 2);
  assert.equal(rescanned[0].value, 'Celeste');
  assert.equal(rescanned[1].value, '••••5678');
  assert.equal(Object.hasOwn(rescanned[1], 'sensitive'), false);

  const replaced = mergeVerifiedProvenance(rescanned, [{
    fieldKey: 'field:2:9',
    label: 'Conditional case number',
    value: '••••8765',
    source: 'record',
  }]);
  assert.equal(replaced.length, 2);
  assert.equal(replaced[1].value, '••••8765');
  assert.equal(replaced[1].source, 'record');
});
