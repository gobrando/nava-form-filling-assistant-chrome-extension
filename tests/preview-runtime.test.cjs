const test = require('node:test');
const assert = require('node:assert/strict');

const previewRuntime = require('../sidepanel/preview-runtime.js');
const policyRules = require('../sidepanel/application-policy.js');
const engine = require('../shared/form-engine.js');
const connectorEngine = require('../shared/connector-engine.js');
const programCatalog = require('../shared/program-catalog.js');
const workQueueEngine = require('../shared/work-queue-engine.js');
const demoConnectorData = require('../shared/demo-connector-data.js');

const DEMO_RECORDS = { 339619: { record_id: '339619', participant: { name: { first: 'Celeste', last: 'Thomas' } } } };

function runtime({ search = '', previewMode = true, state: stateOverrides = {}, parseDocument } = {}) {
  const state = { connector: null, previewPage: 1, apps: [], participant: null, audit: [], view: 'choice', ...stateOverrides };
  const uiTokens = [];
  const api = previewRuntime.create({
    state,
    previewMode,
    demoMode: false,
    search,
    engine,
    connectorEngine,
    programCatalog,
    workQueueEngine,
    DEMO_RECORDS,
    PREVIEW_CONNECTOR_SCHEMA: demoConnectorData.SCHEMA,
    PREVIEW_RAW_RECORD: {
      data: [{ id: demoConnectorData.RECORD_ID, attributes: demoConnectorData.recordAttributes(new Date().toISOString()) }],
    },
    managedConnector: () => state.connector?.mode === 'managed',
    checkpoint: policyRules.checkpoint,
    assertUiGeneration: (token) => uiTokens.push(token),
    parseDocument: parseDocument || (async (file) => ({ file: { name: file.name }, fields: [] })),
  });
  return { ...api, state, uiTokens };
}

test('preview connector responses use the bundled fictional data and only the Apricot-shaped adapter', async () => {
  const preview = runtime();
  assert.deepEqual(await preview.previewRuntime({ type: 'GET_CONNECTOR_STATUS' }), {
    ok: true,
    connector: { mode: 'demo', provider: 'bundled-demo-records', organizationName: 'Nava fictional test data', status: 'ready' },
  });

  const refused = await preview.previewRuntime({ type: 'DISCOVER_CONNECTOR', config: { provider: 'salesforce_nonprofit', organizationName: 'Org', backendUrl: 'http://127.0.0.1:4789', connectionId: 'nava-demo', sourceId: '99', maxAgeDays: 30 } });
  assert.equal(refused.ok, false);
  assert.match(refused.error, /only the fictional Apricot-shaped adapter/);

  const invalid = await preview.previewRuntime({ type: 'DISCOVER_CONNECTOR', config: null });
  assert.equal(invalid.ok, false);
  assert.equal(typeof invalid.error, 'string');

  const discovered = await preview.previewRuntime({ type: 'DISCOVER_CONNECTOR', config: { provider: 'apricot360', organizationName: 'Riverside Community Services', backendUrl: 'http://127.0.0.1:4789', connectionId: 'nava-demo', sourceId: '99', maxAgeDays: 30 } });
  assert.equal(discovered.ok, true);
  assert.equal(discovered.schema.length, demoConnectorData.SCHEMA.length);

  const saved = await preview.previewRuntime({ type: 'SAVE_CONNECTOR', config: { ...discovered.config, mappings: discovered.suggestions }, schema: discovered.schema });
  assert.equal(saved.ok, true, saved.error);
  assert.equal(preview.state.connector.status, 'ready');
  assert.equal(preview.state.connector.schemaFieldCount, discovered.schema.length);

  const lookedUp = await preview.previewRuntime({ type: 'LOOKUP_RECORD', recordId: '339619' });
  assert.equal(lookedUp.message, 'Record loaded from the preview connector.');
  assert.equal(lookedUp.ok, true);
  const missing = await preview.previewRuntime({ type: 'LOOKUP_RECORD', recordId: '1' });
  assert.deepEqual(missing, { ok: false, record: null, message: 'The preview connector includes record 339619.' });

  const reset = await preview.previewRuntime({ type: 'RESET_CONNECTOR' });
  assert.equal(reset.connector.mode, 'demo');
  assert.equal(preview.state.connector.provider, 'bundled-demo-records');
});

test('preview record lookup, recertification, and program responses', async () => {
  const preview = runtime();
  const found = await preview.previewRuntime({ type: 'LOOKUP_RECORD', recordId: 339619 });
  assert.equal(found.ok, true);
  assert.equal(found.record, DEMO_RECORDS['339619']);
  assert.deepEqual(await preview.previewRuntime({ type: 'LOOKUP_RECORD', recordId: '2' }), {
    ok: false,
    record: null,
    message: 'Preview mode only includes demo ID 339619.',
  });

  const caseload = await preview.previewRuntime({ type: 'LIST_RECERTIFICATIONS' });
  assert.equal(caseload.source, 'fictional-demo');
  assert.equal(caseload.cases.length, 1);
  assert.match(caseload.cases[0].dueDate, /^\d{4}-\d{2}-\d{2}$/);

  const opened = await preview.previewRuntime({ type: 'OPEN_PROGRAMS', programs: ['calfresh', 'wic'] });
  assert.equal(opened.ok, true);
  assert.deepEqual(opened.opened.map((item) => item.tabId), opened.opened.map((_, index) => 8000 + index));
  assert.deepEqual(await preview.previewRuntime({ type: 'UNKNOWN' }), { ok: true });
});

test('the simulated application scans, fills, and advances three pages but never submits', async () => {
  const preview = runtime();
  const scan = await preview.previewTabMessage({ type: 'NAVA_SCAN', participant: DEMO_RECORDS['339619'] });
  assert.equal(scan.page.url, 'https://benefitscal.com/ApplyForBenefits/step-1');
  assert.equal(scan.navigationGate.kind, 'next');
  assert.equal(scan.analysis.counts.fields, 4);

  const fill = await preview.previewTabMessage({ type: 'NAVA_FILL', assignments: [{ fieldKey: 'page1:first', value: 'Celeste' }, { fieldKey: 'ssn', value: '123-45-6789', sensitive: true }] });
  assert.deepEqual(fill.results.map((item) => item.status), ['verified', 'verified']);
  assert.equal(fill.provenance[1].value, '••••');
  assert.equal(fill.submitGate.found, false);

  assert.equal((await preview.previewTabMessage({ type: 'NAVA_NAVIGATION_STATUS' })).navigationGate.pageSignature, 'preview:page-1');
  assert.equal((await preview.previewTabMessage({ type: 'NAVA_ADVANCE' })).advanced, true);
  assert.equal(preview.state.previewPage, 2);
  assert.equal((await preview.previewTabMessage({ type: 'NAVA_ADVANCE' })).advanced, true);
  assert.equal(preview.state.previewPage, 3);

  const final = await preview.previewTabMessage({ type: 'NAVA_FILL', assignments: [] });
  assert.deepEqual(final.submitGate, { found: true, enabled: true, botCheckPresent: false, blockedReason: 'The assistant never activates Submit application.' });
  const stay = await preview.previewTabMessage({ type: 'NAVA_ADVANCE' });
  assert.equal(stay.advanced, false);
  assert.equal(stay.navigationGate.kind, 'final_review');
  assert.equal(preview.state.previewPage, 3);

  const first = await preview.previewTabMessage({ type: 'NAVA_NAVIGATION_STATUS' });
  first.navigationGate.kind = 'tampered';
  assert.equal((await preview.previewTabMessage({ type: 'NAVA_NAVIGATION_STATUS' })).navigationGate.kind, 'final_review', 'each reply gets fresh page data');
  assert.deepEqual(await preview.previewTabMessage({ type: 'NAVA_PING' }), { ok: true });
});

test('?queue= fixtures load a paused or source-expired run beside a pending handoff', () => {
  const paused = runtime({ search: '?preview=1&queue=paused' });
  assert.equal(paused.loadPreviewQueueFixture(), true);
  assert.deepEqual(paused.state.apps.map((item) => item.status), ['paused', 'handoff_pending']);
  assert.equal(paused.state.apps[0].checkpoint.kind, 'voluntary_pause');
  assert.equal(paused.state.participant, DEMO_RECORDS['339619']);
  assert.equal(paused.state.previewPage, 2);
  assert.equal(paused.state.view, 'dashboard');
  assert.equal(paused.state.audit[0].id, 'preview-event');

  const expired = runtime({ search: '?queue=expired' });
  assert.equal(expired.loadPreviewQueueFixture(), true);
  assert.equal(expired.state.apps[0].status, 'source_expired');
  assert.equal(expired.state.apps[0].checkpoint.label, 'Reload client data');
  assert.equal(expired.state.participant, null);

  assert.equal(runtime({ search: '' }).loadPreviewQueueFixture(), false);
  assert.equal(runtime({ search: '?queue=paused', previewMode: false }).loadPreviewQueueFixture(), false);
});

test('?fixture= loads only bundled sample documents and opens their review', async () => {
  const fetched = [];
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    fetched.push(url);
    return { ok: true, arrayBuffer: async () => new ArrayBuffer(4) };
  };
  try {
    const parsed = [];
    const preview = runtime({
      search: '?fixture=csv&conflict=1',
      parseDocument: async (file) => {
        parsed.push({ name: file.name, type: file.type });
        return { fields: [] };
      },
    });
    assert.equal(await preview.loadPreviewDocumentFixture(5), true);
    assert.deepEqual(fetched, ['../demo/fixtures/sample-business.csv']);
    assert.deepEqual(parsed, [{ name: 'sample-business.csv', type: 'text/csv' }]);
    assert.deepEqual(preview.uiTokens, [5]);
    assert.equal(preview.state.view, 'document-review');
    assert.equal(preview.state.participant, DEMO_RECORDS['339619']);

    assert.equal(await runtime({ search: '?fixture=unknown' }).loadPreviewDocumentFixture(1), false);
    assert.equal(await runtime({ search: '?fixture=pdf', previewMode: false }).loadPreviewDocumentFixture(1), false);
    assert.equal(fetched.length, 1);

    globalThis.fetch = async () => ({ ok: false });
    await assert.rejects(runtime({ search: '?fixture=pdf' }).loadPreviewDocumentFixture(1), /local preview document could not be loaded/);
  } finally {
    globalThis.fetch = previousFetch;
  }
});
