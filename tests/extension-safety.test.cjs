const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');

test('manifest is valid MV3 and loads the side panel', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.side_panel.default_path, 'sidepanel/index.html');
  assert.ok(manifest.permissions.includes('sidePanel'));
});

test('page agent exposes no submit command and never invokes requestSubmit', () => {
  const source = fs.readFileSync(path.join(root, 'content/form-agent.js'), 'utf8');
  assert.doesNotMatch(source, /requestSubmit\s*\(/);
  assert.doesNotMatch(source, /\.submit\s*\(/);
  assert.doesNotMatch(source, /NAVA_SUBMIT\b/);
  assert.match(source, /submitGateStatus/);
});

test('cross-page automation only exposes gated advance and stops on final actions', () => {
  const agent = fs.readFileSync(path.join(root, 'content/form-agent.js'), 'utf8');
  const panel = fs.readFileSync(path.join(root, 'sidepanel/sidepanel.js'), 'utf8');
  assert.match(agent, /NAVA_ADVANCE/);
  assert.match(agent, /SAFE_ADVANCE_LABELS/);
  assert.match(agent, /FINAL_ACTION_PATTERN/);
  assert.match(agent, /certif\|attest\|affirm/);
  assert.match(agent, /decision\.gate\.kind !== 'next'/);
  assert.match(agent, /oneTimeCodeStatus/);
  assert.match(agent, /one-time code before the assistant can continue/);
  assert.match(agent, /MAX_FILL_ASSIGNMENTS = 80/);
  assert.match(agent, /more than the \$\{MAX_FILL_ASSIGNMENTS\}-field verified-fill safety limit/);
  assert.match(panel, /MAX_AUTOMATED_PAGES = 60/);
  assert.match(panel, /DEFAULT_AUTOMATED_PAGES = 12/);
  assert.match(panel, /NAVIGATION_TIMEOUT_MS = 60_000/);
  assert.match(panel, /visitedSignatures/);
  assert.doesNotMatch(panel, /NAVA_SUBMIT\b/);

  const patternLiteral = agent.match(/const FINAL_PAGE_PATTERN = (\/.*\/i);/)?.[1];
  assert.ok(patternLiteral, 'final-page pattern should be declared');
  const finalPagePattern = Function(`return ${patternLiteral}`)();
  assert.doesNotMatch('Fill in and submit your application', finalPagePattern);
  assert.match('Review and submit', finalPagePattern);
  assert.match('Certification and signature', finalPagePattern);
});

test('multi-page fixture marks itself safe for navigation but retains a submit guard', () => {
  const html = fs.readFileSync(path.join(root, 'demo/multi-page.html'), 'utf8');
  const script = fs.readFileSync(path.join(root, 'demo/multi-page.js'), 'utf8');
  assert.match(html, /data-nava-demo-flow="true"/);
  assert.match(script, />Next</);
  assert.match(script, />Save and continue</);
  assert.match(script, /Review and submit/);
  assert.match(script, /type="submit">Submit application/);
});

test('public demo fixtures are passive and require the installed extension', () => {
  const files = [
    'demo/demo-form.html',
    'demo/demo.js',
    'demo/multi-page.html',
    'demo/multi-page.js',
    'demo/extensive-application.html',
    'demo/extensive-application.js',
  ];
  const source = files.map((file) => fs.readFileSync(path.join(root, file), 'utf8')).join('\n');
  assert.doesNotMatch(source, /NavaPageAgentTestApi/);
  assert.doesNotMatch(source, /content\/form-agent\.js/);
  assert.doesNotMatch(source, /shared\/form-engine\.js/);
  assert.doesNotMatch(source, /record_id:\s*['"]339619/);
  assert.doesNotMatch(source, /URLSearchParams[\s\S]{0,120}autorun/);

  const agent = fs.readFileSync(path.join(root, 'content/form-agent.js'), 'utf8');
  assert.match(agent, /function trustedDemoFixture\(\)/);
  assert.match(agent, /http:\/\/127\.0\.0\.1:4173/);
  assert.doesNotMatch(agent, /NavaPageAgentTestApi/);
});

test('multi-application runs are tab-bound, automatic, and origin-checked', () => {
  const panel = fs.readFileSync(path.join(root, 'sidepanel/sidepanel.js'), 'utf8');
  const agent = fs.readFileSync(path.join(root, 'content/form-agent.js'), 'utf8');
  assert.match(panel, /enqueueApplicationBatch\(applicationsToRun\.map/);
  assert.match(panel, /MAX_PARALLEL_APPLICATIONS = 3/);
  assert.match(panel, /assertApprovedApplicationLocation\(application, tab\.url\)/);
  const scanTabSource = panel.slice(panel.indexOf('async function scanTab'), panel.indexOf('async function openSelectedPrograms'));
  assert.ok(
    scanTabSource.indexOf('assertApprovedApplicationLocation(requestedApplication, tab.url)')
      < scanTabSource.indexOf("type: 'NAVA_SCAN'"),
    'known application origin and path must be approved before client data is sent to the tab',
  );
  assert.match(panel, /activeRunTokens/);
  assert.match(panel, /async function beginApplicationRun[\s\S]*while \(activeRunTokens\.has\(application\.id\)\)[\s\S]*await existing\.settled/);
  assert.match(panel, /runToken = await beginApplicationRun\(application\)/);
  assert.match(panel, /requestedUiGeneration !== uiGeneration/);
  assert.match(panel, /token\.resolveSettled\(\)/);
  assert.match(panel, /NAVA_CANCEL/);
  assert.match(panel, /application\.lease\?\.holder === state\.workerId/);
  assert.match(panel, /probe\.documentId/);
  assert.match(panel, /documentIds: \[documentId\]/);
  assert.match(panel, /type: 'EXECUTE_APPLICATION_COMMAND'/);
  assert.match(panel, /command,/);
  assert.match(panel, /documentId: probe\.documentId/);
  assert.match(agent, /function routeAuthorized\(policy\)/);
  assert.match(agent, /expectedPath === location\.pathname/);
  assert.match(agent, /No form action was taken/);
  assert.match(panel, /persistChain/);
  assert.match(panel, /data-action="scan-application" data-app=/);
  assert.doesNotMatch(panel, /data-action="analyze-current">Analyze current tab<\/button>`;\n\s*}/);
});

test('header home control and provider catalog are reachable', () => {
  const html = fs.readFileSync(path.join(root, 'sidepanel/index.html'), 'utf8');
  const panel = fs.readFileSync(path.join(root, 'sidepanel/sidepanel.js'), 'utf8');
  assert.match(html, /data-action="home"/);
  assert.match(panel, /document\.addEventListener\('click'/);
  assert.match(panel, /renderProviderCatalog/);
  assert.match(panel, /select-provider/);
  assert.match(panel, /Only the fictional Apricot-shaped adapter runs/);
  assert.match(panel, /provider\.readiness === 'demo-tested'/);
  assert.match(panel, /Provisioned Nava adapter required/);
  assert.doesNotMatch(panel, /data-provider="\$\{escapeHtml\(provider\.id\)\}" \$\{available \? '' : 'disabled'\}/);
  assert.match(panel, /sameMappedSource/);
  assert.match(panel, /cancelPendingUiWork/);
  assert.match(panel, /async function cancelUiBoundRuns\(\)[\s\S]*await revokeApplicationRun\(application\)/);
  assert.match(panel, /if \(action === 'home'\) \{\n\s*await cancelUiBoundRuns\(\)/);
  assert.match(panel, /assertUiGeneration/);
  assert.match(html, /Simulated UI preview · no browser form or database is being used/);
  assert.match(panel, /value="current" \$\{currentAllowed \? '' : 'disabled'\}/);
});

test('extension contains no remote scripts or inline executable script', () => {
  const html = fs.readFileSync(path.join(root, 'sidepanel/index.html'), 'utf8');
  assert.doesNotMatch(html, /<script[^>]+https?:/i);
  assert.doesNotMatch(html, /<script>[^<]/i);
});

test('document intake uses only bundled parsers and never persists the raw file', () => {
  const html = fs.readFileSync(path.join(root, 'sidepanel/index.html'), 'utf8');
  const parser = fs.readFileSync(path.join(root, 'sidepanel/document-parser.js'), 'utf8');
  const panel = fs.readFileSync(path.join(root, 'sidepanel/sidepanel.js'), 'utf8');

  assert.match(html, /vendor\/fflate\.min\.js/);
  assert.match(parser, /vendor\/pdf\.min\.mjs/);
  assert.doesNotMatch(parser, /fetch\s*\(|XMLHttpRequest|WebSocket/);
  assert.doesNotMatch(panel, /clientDocument[^\n]+storage/);
  assert.ok(fs.existsSync(path.join(root, 'vendor/pdf.worker.min.mjs')));
  assert.ok(fs.existsSync(path.join(root, 'vendor/licenses/PDFJS-LICENSE.txt')));
  assert.ok(fs.existsSync(path.join(root, 'vendor/licenses/FFLATE-LICENSE.txt')));
});

test('OCR uses only bundled assets, enforces resource limits, and requires field review', () => {
  const html = fs.readFileSync(path.join(root, 'sidepanel/index.html'), 'utf8');
  const ocr = fs.readFileSync(path.join(root, 'sidepanel/ocr-engine.js'), 'utf8');
  const parser = fs.readFileSync(path.join(root, 'sidepanel/document-parser.js'), 'utf8');
  const panel = fs.readFileSync(path.join(root, 'sidepanel/sidepanel.js'), 'utf8');

  assert.match(html, /ocr-engine\.js/);
  assert.match(ocr, /vendor\/tesseract\/tesseract\.esm\.min\.js/);
  assert.match(ocr, /MAX_OCR_PAGES = 8/);
  assert.match(ocr, /MAX_PAGE_PIXELS = 8_000_000/);
  assert.match(ocr, /MAX_TOTAL_PIXELS = 32_000_000/);
  assert.match(ocr, /MAX_OCR_ATTEMPTS = 10/);
  assert.doesNotMatch(ocr, /https?:\/\//i);
  assert.match(parser, /reviewRequired: true/);
  assert.match(panel, /field\.reviewRequired \? '' : 'checked'/);
  assert.match(panel, /image\/png/);

  [
    'vendor/tesseract/tesseract.esm.min.js',
    'vendor/tesseract/worker.min.js',
    'vendor/tesseract/core/tesseract-core-lstm.wasm.js',
    'vendor/tesseract/core/tesseract-core-lstm.wasm',
    'vendor/tesseract/lang-data/eng.traineddata.gz',
    'vendor/licenses/TESSERACT-JS-LICENSE.txt',
    'vendor/licenses/TESSERACT-CORE-LICENSE.txt',
    'vendor/licenses/TESSDATA-FAST-LICENSE.txt',
  ].forEach((relativePath) => assert.ok(fs.existsSync(path.join(root, relativePath)), `${relativePath} should be bundled`));
  assert.ok(fs.existsSync(path.join(root, 'demo/fixtures/sample-client-scan.pdf')));
});

test('resumable work queue persists only sanitized metadata and verifies before resume', () => {
  const html = fs.readFileSync(path.join(root, 'sidepanel/index.html'), 'utf8');
  const panel = fs.readFileSync(path.join(root, 'sidepanel/sidepanel.js'), 'utf8');
  const background = fs.readFileSync(path.join(root, 'background.js'), 'utf8');
  const persistSource = panel.slice(panel.indexOf('async function persist'), panel.indexOf('async function clearAssistantState'));
  const acquireSource = panel.slice(panel.indexOf('async function acquireApplicationLease'), panel.indexOf('async function releaseApplicationLease'));
  const releaseSource = panel.slice(panel.indexOf('async function releaseApplicationLease'), panel.indexOf('async function withApplicationLease'));
  const withLeaseSource = panel.slice(panel.indexOf('async function withApplicationLease'), panel.indexOf('async function renewApplicationLease'));
  const queuedRunSource = panel.slice(panel.indexOf('async function runQueuedApplication'), panel.indexOf('function eligibleAutomaticApplication'));
  const leaseRetrySource = panel.slice(panel.indexOf('function scheduleLeaseRetry'), panel.indexOf('function pumpAutomaticRunQueue'));
  const targetedSyncSource = panel.slice(panel.indexOf('async function synchronizeApplications'), panel.indexOf('function observeCoordinator'));

  assert.match(html, /shared\/work-queue-engine\.js/);
  assert.match(panel, /CLAIM_CLIENT_SESSION/);
  assert.match(panel, /UPDATE_SESSION_PARTICIPANT/);
  assert.doesNotMatch(persistSource, /participant: state\.participant/);
  assert.match(panel, /const queueSnapshot = durableQueue\(applicationIds\)/);
  assert.match(persistSource, /state\.apps\.filter\(\(application\) => selectedIds\.has\(application\.id\)\)/);
  assert.match(persistSource, /includeCurrentAppId \? \{ currentAppId: state\.currentAppId \} : \{\}/);
  assert.match(panel, /type: 'PERSIST_ASSISTANT_STATE'/);
  assert.match(panel, /type: 'CLEAR_ASSISTANT_STATE'/);
  assert.match(background, /coordinatorChain/);
  assert.match(background, /chrome\.storage\.session\.set\(\{ \[SESSION_STORAGE_KEY\]: mergedSession \}\)/);
  assert.match(background, /\[QUEUE_STORAGE_KEY\]: mergedQueue/);
  assert.match(background, /COORDINATOR_STORAGE_KEY/);
  assert.match(background, /sessionEpoch/);
  assert.match(background, /applicationGenerations/);
  assert.match(background, /applicationRevisions/);
  assert.match(background, /stateRevision/);
  assert.match(background, /EXECUTE_APPLICATION_COMMAND/);
  assert.match(background, /REVOKE_APPLICATION_RUN/);
  assert.match(background, /CHECK_APPLICATION_RUN/);
  assert.match(background, /ACQUIRE_APPLICATION_LEASE/);
  assert.match(background, /RELEASE_APPLICATION_LEASE/);
  assert.match(background, /const COMMAND_LEASE_MS = 10 \* 60 \* 1000/);
  assert.match(background, /shortenCommandLease/);
  assert.doesNotMatch(panel, /chrome\.storage\.session\.remove\('nava:session'\)/);
  assert.match(panel, /workQueueEngine\.resumeDecision/);
  assert.match(panel, /NAVA_SCAN/);
  assert.match(panel, /withApplicationLease/);
  assert.match(persistSource, /response\?\.code === 'STALE_STATE_REVISION'/);
  assert.match(persistSource, /for \(let attempt = 0; attempt < 2; attempt \+= 1\)/);
  assert.match(persistSource, /await waitForCoordinatorSync\(\)/);
  assert.match(panel, /locallyUnpersistedIds/);
  assert.match(panel, /return local && !changedIds\.has\(authoritative\.id\)/);
  assert.doesNotMatch(acquireSource, /await persist\(\)/, 'lease acquisition must return before checkpoint persistence can fail');
  assert.doesNotMatch(releaseSource, /await persist\(\)/, 'central lease release must not re-persist a stale application snapshot');
  assert.ok(
    withLeaseSource.indexOf('try {') < withLeaseSource.indexOf('await persist(')
      && withLeaseSource.indexOf('await persist(') < withLeaseSource.indexOf('finally')
      && withLeaseSource.indexOf('finally') < withLeaseSource.indexOf('releaseApplicationLease'),
    'post-acquire persistence must be protected by lease release in finally',
  );
  assert.doesNotMatch(
    queuedRunSource.slice(0, queuedRunSource.indexOf('await withApplicationLease')),
    /await persist\(\)/,
    'automatic recovery must acquire the central lease before persisting its startup checkpoint',
  );
  assert.match(withLeaseSource, /persist\(\{ applicationIds: \[application\.id\] \}\)/);
  assert.match(panel, /application\.runStopReason = '';\n\s*await persist\(\{ applicationIds: \[application\.id\] \}\)/);
  assert.match(queuedRunSource, /scheduleCoordinatorRetry\(applicationId\)/);
  assert.match(queuedRunSource, /if \(existingRun && !existingRun\.cancelled\) return/);
  assert.match(panel, /function scheduleCoordinatorRetry\(applicationId\)[\s\S]*scheduleCoordinatorSync\(applicationId\)[\s\S]*enqueueApplicationBatch\(\[applicationId\]\)/);
  assert.match(queuedRunSource, /scheduleLeaseRetry\(applicationId, error\.lease\)/);
  assert.doesNotMatch(
    queuedRunSource,
    /LeaseConflictError'[\s\S]{0,140}scheduleCoordinatorSync/,
    'a losing lease contender must not synchronize by cancelling the current holder\'s tab command',
  );
  assert.match(leaseRetrySource, /Date\.parse\(lease\?\.expiresAt/);
  assert.match(leaseRetrySource, /setTimeout/);
  assert.match(leaseRetrySource, /enqueueApplicationBatch\(\[applicationId\]\)/);
  assert.match(panel, /const APPLICATION_LEASE_MS = 2 \* 60 \* 1000/);
  assert.match(panel, /automaticWorkersActive < MAX_PARALLEL_APPLICATIONS/);
  assert.match(panel, /automaticRunQueue\.shift\(\)/);
  assert.match(targetedSyncSource, /ids\.forEach[\s\S]*cancelApplicationRun/);
  assert.doesNotMatch(
    queuedRunSource,
    /RunCancelledError'[\s\S]{0,180}scheduleCoordinatorSync\(\)/,
    'one application conflict must not request a global sibling-cancelling sync',
  );
  assert.match(panel, /exportAudit/);
  assert.match(panel, /handoff_created/);
  assert.match(background, /workQueueEngine\.markTabClosed/);
  assert.doesNotMatch(background, /nava:application:/);
});

test('managed connector is read-only and stores only validated configuration', () => {
  const background = fs.readFileSync(path.join(root, 'background.js'), 'utf8');
  const mock = fs.readFileSync(path.join(root, 'connector-service/mock-server.mjs'), 'utf8');
  const panel = fs.readFileSync(path.join(root, 'sidepanel/sidepanel.js'), 'utf8');

  assert.match(background, /connectorEngine\.validateMappings\(message\.config, schema\)/);
  assert.match(background, /chrome\.storage\.local\.set/);
  assert.match(background, /method: 'GET'/);
  assert.match(background, /credentials: 'include'/);
  assert.doesNotMatch(background, /method:\s*['"](?:POST|PUT|PATCH|DELETE)['"]/);
  assert.match(mock, /server\.listen\(port, '127\.0\.0\.1'/);
  assert.match(mock, /Read-only mock: GET requests only/);
  assert.match(panel, /Confirm this client/);
  assert.match(panel, /confirm-connector-record/);
});
