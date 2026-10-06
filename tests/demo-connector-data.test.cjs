const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const vm = require('node:vm');

const demoData = require('../shared/demo-connector-data.js');
const connectorEngine = require('../shared/connector-engine.js');

const root = path.resolve(__dirname, '..');

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
