import http from 'node:http';
import demoConnectorData from '../shared/demo-connector-data.js';

const port = Number(process.env.PORT || 4789);
const sourceId = String(demoConnectorData.FORM_ID);
const schema = demoConnectorData.SCHEMA;

const records = {
  [String(demoConnectorData.RECORD_ID)]: {
    data: [{
      id: demoConnectorData.RECORD_ID,
      type: 'records',
      attributes: demoConnectorData.recordAttributes(new Date().toISOString()),
    }],
  },
};

function isoDateOffset(days) {
  const now = new Date();
  const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

const recertificationCases = [
  {
    id: 'mock-recert-339619-calfresh', recordId: '339619', displayName: 'Celeste Thomas II', firstName: 'Celeste',
    programId: 'calfresh', programName: 'CalFresh', dueDate: isoDateOffset(12), preferredContact: 'Email',
    requirements: {
      contact: { status: 'current' }, household: { status: 'missing' }, income: { status: 'stale' },
      expenses: { status: 'missing' }, documents: { status: 'missing' },
    },
  },
];

function json(response, status, payload, origin) {
  response.writeHead(status, {
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Headers': 'Accept, Content-Type',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Origin': origin || 'null',
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json; charset=utf-8',
    Vary: 'Origin',
  });
  response.end(JSON.stringify(payload));
}

function allowedOrigin(origin) {
  return !origin || origin === 'null' || origin.startsWith('chrome-extension://') || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
}

function requestedSource(url) {
  return url.searchParams.get('sourceId') || url.searchParams.get('formId');
}

/** [status, payload] for one read-only connector resource; every resource except health is scoped to the demo source. */
function connectorResponse(match, url) {
  const resource = match[2];
  if (resource === 'health') {
    return [200, { ok: true, provider: 'apricot360', organizationName: 'Riverside Community Services', mode: 'local-demo' }];
  }
  if (requestedSource(url) !== sourceId) return [404, { ok: false, error: 'Source not found.' }];
  if (resource === 'schema') return [200, { ok: true, fields: schema }];
  if (resource === 'recertifications') return [200, { ok: true, cases: recertificationCases }];
  const record = records[decodeURIComponent(match[3] || '')];
  return [record ? 200 : 404, record || { ok: false, error: 'Record not found.' }];
}

const server = http.createServer((request, response) => {
  const origin = request.headers.origin || '';
  if (!allowedOrigin(origin)) return json(response, 403, { ok: false, error: 'Origin not allowed.' }, 'null');
  if (request.method === 'OPTIONS') return json(response, 204, {}, origin);
  if (request.method !== 'GET') return json(response, 405, { ok: false, error: 'Read-only mock: GET requests only.' }, origin);

  const url = new URL(request.url, `http://${request.headers.host}`);
  const match = url.pathname.match(/^\/v1\/connectors\/([^/]+)\/(health|schema|recertifications|records(?:\/([^/]+))?)$/);
  if (!match || decodeURIComponent(match[1]) !== 'nava-demo') {
    return json(response, 404, { ok: false, error: 'Connector not found.' }, origin);
  }
  const [status, payload] = connectorResponse(match, url);
  return json(response, status, payload, origin);
});

server.listen(port, '127.0.0.1', () => {
  console.log(`Nava connector mock listening on http://127.0.0.1:${port}`);
});
