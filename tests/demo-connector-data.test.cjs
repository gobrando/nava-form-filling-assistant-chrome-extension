const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const vm = require('node:vm');

const demoData = require('../shared/demo-connector-data.js');
const connectorEngine = require('../shared/connector-engine.js');
const programCatalog = require('../shared/program-catalog.js');
const recertificationEngine = require('../shared/recertification-engine.js');
const coordinatorRules = require('../background/coordinator-rules.js');

const root = path.resolve(__dirname, '..');

/**
 * The service worker's connector client with no managed connector saved, so it answers from the shared demo data.
 * Its clock reads `clock.now`, so a test can move "today" between requests.
 */
function serviceWorkerDemoConnector(clock) {
  class ClockDate extends Date {
    constructor(...args) {
      super(...(args.length ? args : [clock.now]));
    }
  }
  const context = { Date: ClockDate, chrome: { storage: { local: { async get() { return {}; } } } } };
  context.globalThis = context;
  const script = 'background/connector-client.js';
  vm.runInNewContext(fs.readFileSync(path.join(root, script), 'utf8'), context, { filename: script });
  const client = context.NavaConnectorClient.create({
    rules: coordinatorRules,
    connectorEngine,
    programCatalog,
    recertificationEngine,
    demoConnectorData: demoData,
    storageKeys: { CONNECTOR_STORAGE_KEY: 'nava:connector' },
  });
  return (message) => new Promise((resolve) => {
    assert.equal(client.routeConnectorMessage(message, {}, resolve), true);
  });
}

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

async function withMockConnector(action) {
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(root, 'connector-service/mock-server.mjs')], {
    env: { ...process.env, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code) => reject(new Error(`mock connector exited with ${code}`)));
      child.stdout.once('data', resolve);
    });
    return await action(`http://127.0.0.1:${port}/v1/connectors/nava-demo`);
  } finally {
    child.kill();
  }
}

/** The side panel's preview fixture, evaluated from sidepanel.js against the shared module. */
function previewFixture() {
  const source = fs.readFileSync(path.join(root, 'sidepanel/sidepanel.js'), 'utf8');
  const start = source.indexOf('const PREVIEW_CONNECTOR_SCHEMA');
  const recordStart = source.indexOf('const PREVIEW_RAW_RECORD', start);
  const end = source.indexOf('\n  };\n', recordStart);
  assert.ok(start >= 0 && recordStart > start && end > recordStart, 'preview connector fixture should be declared in sidepanel.js');
  const context = { demoConnectorData: demoData };
  vm.runInNewContext(`${source.slice(start, end + 5)}\nresult = { PREVIEW_CONNECTOR_SCHEMA, PREVIEW_RAW_RECORD };`, context);
  return context.result;
}

test('the shared demo form has 28 uniquely numbered fields and a record value for each one', () => {
  assert.equal(demoData.SCHEMA.length, 28);
  assert.equal(new Set(demoData.SCHEMA.map((field) => field.id)).size, 28);
  const attributes = demoData.recordAttributes('2026-01-01T00:00:00.000Z');
  assert.equal(attributes.form_id, demoData.FORM_ID);
  assert.equal(attributes.mod_time, '2026-01-01T00:00:00.000Z');
  assert.deepEqual(
    Object.keys(attributes).filter((key) => key.startsWith('field_')),
    demoData.SCHEMA.map((field) => `field_${field.id}`),
  );
  assert.notEqual(demoData.recordAttributes('x'), demoData.recordAttributes('x'), 'each call returns a fresh record');
});

test('the mock connector and the side-panel preview serve the same schema and record attributes', async () => {
  const preview = previewFixture();
  assert.equal(preview.PREVIEW_CONNECTOR_SCHEMA, demoData.SCHEMA);
  const [previewRecord] = preview.PREVIEW_RAW_RECORD.data;

  await withMockConnector(async (base) => {
    const schema = await (await fetch(`${base}/schema?sourceId=${demoData.FORM_ID}`)).json();
    assert.deepEqual(schema, { ok: true, fields: preview.PREVIEW_CONNECTOR_SCHEMA });

    const recordUrl = `${base}/records/${demoData.RECORD_ID}?sourceId=${demoData.FORM_ID}`;
    const [served] = (await (await fetch(recordUrl)).json()).data;
    assert.equal(served.id, previewRecord.id);
    assert.equal(served.type, 'records');
    assert.equal(Object.hasOwn(previewRecord, 'type'), false);
    assert.deepEqual(served.attributes, { ...previewRecord.attributes, mod_time: served.attributes.mod_time });
    const [again] = (await (await fetch(recordUrl)).json()).data;
    assert.equal(again.attributes.mod_time, served.attributes.mod_time, 'mod_time is stamped once at startup');

    const fields = connectorEngine.normalizeSchemaFields(schema);
    const config = connectorEngine.validateMappings({
      provider: 'apricot360',
      organizationName: 'Demo organization',
      backendUrl: 'http://127.0.0.1:4789',
      connectionId: 'nava-demo',
      sourceId: String(demoData.FORM_ID),
      maxAgeDays: 30,
      mappings: connectorEngine.suggestMappings(fields),
    }, schema);
    const retrievedAt = new Date().toISOString();
    const fromMock = connectorEngine.mapRecord({ data: [served] }, config, schema, retrievedAt);
    const fromPreview = connectorEngine.mapRecord(preview.PREVIEW_RAW_RECORD, config, preview.PREVIEW_CONNECTOR_SCHEMA, retrievedAt);
    assert.equal(fromMock.found, true);
    assert.deepEqual(fromPreview.provenance, fromMock.provenance);
    assert.deepEqual(
      { ...fromPreview.record, _connector: undefined },
      { ...fromMock.record, _connector: undefined },
    );
  });
});

test('the shared recertification caseload builds connector cases with prefixed ids and day-offset due dates', () => {
  const now = new Date('2026-03-30T23:59:00.000Z');
  assert.equal(demoData.isoDateOffset(0, now), '2026-03-30');
  assert.equal(demoData.isoDateOffset(12, now), '2026-04-11');
  assert.equal(demoData.isoDateOffset(-3, now), '2026-03-27');
  assert.equal(demoData.isoDateOffset(2, new Date('2026-12-30T00:00:00.000Z')), '2027-01-01');

  assert.deepEqual(
    demoData.RECERTIFICATION_CASELOAD.map((entry) => [entry.recordId, entry.programId, entry.dueInDays]),
    [['339637', 'calworks', -3], ['339619', 'calfresh', 12], ['338618', 'medical', 33]],
  );
  const recordIds = new Set(demoData.CLIENT_RECORDS.map((record) => record.record_id));
  assert.deepEqual([...recordIds], ['339619', '338618', '339637']);
  assert.ok(demoData.RECERTIFICATION_CASELOAD.every((entry) => recordIds.has(entry.recordId)), 'every case belongs to a bundled client');

  const [calworks] = demoData.RECERTIFICATION_CASELOAD;
  const served = demoData.recertificationCase(calworks, 'demo-recert', now);
  assert.deepEqual(Object.keys(served), [
    'id', 'recordId', 'displayName', 'firstName', 'programId', 'programName', 'dueDate', 'preferredContact', 'requirements',
  ]);
  assert.equal(served.id, 'demo-recert-339637-calworks');
  assert.equal(served.dueDate, '2026-03-27');
  assert.deepEqual(served.requirements, calworks.requirements);
  assert.notEqual(served.requirements, calworks.requirements, 'each case gets its own requirements');
});

test('the service worker serves the shared caseload as demo-recert cases due relative to each request', async () => {
  const clock = { now: '2026-03-30T12:00:00.000Z' };
  const request = serviceWorkerDemoConnector(clock);
  const first = await request({ type: 'LIST_RECERTIFICATIONS' });
  assert.equal(first.ok, true);
  assert.equal(first.source, 'fictional-demo');
  assert.deepEqual(first.cases.map((item) => [item.id, item.source, item.dueDate, item.daysUntilDue]), [
    ['demo-recert-339637-calworks', 'fictional-demo', '2026-03-27', -3],
    ['demo-recert-339619-calfresh', 'fictional-demo', '2026-04-11', 12],
    ['demo-recert-338618-medical', 'fictional-demo', '2026-05-02', 33],
  ]);

  clock.now = '2026-04-02T12:00:00.000Z';
  const later = await request({ type: 'LIST_RECERTIFICATIONS' });
  assert.deepEqual(later.cases.map((item) => item.dueDate), ['2026-03-30', '2026-04-14', '2026-05-05']);
});

test('the mock connector and the service worker serve the same CalFresh case apart from id and source', async () => {
  const startedOn = new Date();
  const swAnswer = await serviceWorkerDemoConnector({ now: startedOn.toISOString() })({ type: 'LIST_RECERTIFICATIONS' });
  const swCase = swAnswer.cases.find((item) => item.id === 'demo-recert-339619-calfresh');
  assert.ok(swCase);

  await withMockConnector(async (base) => {
    const served = await (await fetch(`${base}/recertifications?sourceId=${demoData.FORM_ID}`)).json();
    assert.equal(served.ok, true);
    assert.equal(served.cases.length, 1);
    const [mockCase] = served.cases;
    assert.deepEqual(Object.keys(mockCase), [
      'id', 'recordId', 'displayName', 'firstName', 'programId', 'programName', 'dueDate', 'preferredContact', 'requirements',
    ]);
    assert.deepEqual(mockCase, {
      id: 'mock-recert-339619-calfresh', recordId: '339619', displayName: 'Celeste Thomas II', firstName: 'Celeste',
      programId: 'calfresh', programName: 'CalFresh', dueDate: demoData.isoDateOffset(12, startedOn), preferredContact: 'Email',
      requirements: {
        contact: { status: 'current' }, household: { status: 'missing' }, income: { status: 'stale' },
        expenses: { status: 'missing' }, documents: { status: 'missing' },
      },
    });
    assert.equal(Object.hasOwn(mockCase, 'source'), false, 'the mock connector serves no source key');

    const [normalizedMock] = recertificationEngine.normalizeCaseload(served.cases, { today: startedOn });
    assert.deepEqual(
      { ...normalizedMock, id: undefined, source: undefined },
      { ...swCase, id: undefined, source: undefined },
    );
  });
});
