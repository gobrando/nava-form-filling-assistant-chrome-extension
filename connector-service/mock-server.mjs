import http from 'node:http';

const port = Number(process.env.PORT || 4789);
const schema = [
  { id: 101, label: 'First Name', type: 'text', reference_tag: 'firstName' },
  { id: 102, label: 'Middle Name', type: 'text', reference_tag: 'middleName' },
  { id: 103, label: 'Last Name', type: 'text', reference_tag: 'lastName' },
  { id: 104, label: 'Date of Birth', type: 'date', reference_tag: 'dateOfBirth' },
  { id: 105, label: 'Primary Email', type: 'email', reference_tag: 'email' },
  { id: 106, label: 'Cell Phone', type: 'phone', reference_tag: 'phone' },
  { id: 107, label: 'Residential Address', type: 'text', reference_tag: 'addressLine1' },
  { id: 108, label: 'Apartment or Unit', type: 'text', reference_tag: 'addressLine2' },
  { id: 109, label: 'Residential City', type: 'text', reference_tag: 'city' },
  { id: 110, label: 'Residential State', type: 'text', reference_tag: 'state' },
  { id: 111, label: 'Residential County', type: 'text', reference_tag: 'county' },
  { id: 112, label: 'ZIP Code', type: 'text', reference_tag: 'postalCode' },
  { id: 113, label: 'Preferred Language', type: 'select', reference_tag: 'primaryLanguage' },
  { id: 114, label: 'Gender', type: 'select', reference_tag: 'gender' },
  { id: 115, label: 'Ethnicity', type: 'select', reference_tag: 'ethnicity' },
  { id: 116, label: 'Marital Status', type: 'select', reference_tag: 'maritalStatus' },
  { id: 117, label: 'Special Needs', type: 'boolean', reference_tag: 'specialNeeds' },
  { id: 118, label: 'Farm Worker', type: 'boolean', reference_tag: 'farmWorker' },
  { id: 119, label: 'Preferred Contact Method', type: 'select', reference_tag: 'preferredContact' },
  { id: 120, label: 'Housing Status', type: 'select', reference_tag: 'housingStatus' },
  { id: 121, label: 'Household Size', type: 'number', reference_tag: 'householdSize' },
  { id: 122, label: 'Citizenship Status', type: 'select', reference_tag: 'immigrationStatus' },
  { id: 123, label: 'Monthly Household Income', type: 'currency', reference_tag: 'income' },
  { id: 124, label: 'Pays for Childcare', type: 'boolean', reference_tag: 'childcare' },
  { id: 125, label: 'Receives Unemployment Benefits', type: 'boolean', reference_tag: 'unemployment' },
  { id: 126, label: 'Pregnancy Status', type: 'boolean', reference_tag: 'pregnant' },
  { id: 127, label: 'Social Security Number', type: 'sensitive', reference_tag: 'ssn' },
  { id: 128, label: 'Residential Country', type: 'text', reference_tag: 'country' },
];

const records = {
  '339619': {
    data: [{
      id: 339619,
      type: 'records',
      attributes: {
        form_id: 99,
        mod_time: new Date().toISOString(),
        field_101: 'Celeste',
        field_102: 'NAVA',
        field_103: 'Thomas II',
        field_104: '2000-01-02',
        field_105: 'testnava@email.com',
        field_106: '777-777-7777',
        field_107: '5556 Test Blvd',
        field_108: 'Apt 556',
        field_109: 'WILDOMAR',
        field_110: 'California',
        field_111: 'Riverside',
        field_112: '92595',
        field_113: 'English',
        field_114: 'Female',
        field_115: 'Hispanic/Latino',
        field_116: 'Single',
        field_117: false,
        field_118: false,
        field_119: 'Email',
        field_120: 'Stable housing',
        field_121: '3',
        field_122: 'U.S. citizen',
        field_123: '1850',
        field_124: true,
        field_125: false,
        field_126: false,
        field_127: '123-45-6789',
        field_128: 'United States',
      },
    }],
  },
};

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

const server = http.createServer((request, response) => {
  const origin = request.headers.origin || '';
  if (!allowedOrigin(origin)) return json(response, 403, { ok: false, error: 'Origin not allowed.' }, 'null');
  if (request.method === 'OPTIONS') return json(response, 204, {}, origin);
  if (request.method !== 'GET') return json(response, 405, { ok: false, error: 'Read-only mock: GET requests only.' }, origin);

  const url = new URL(request.url, `http://${request.headers.host}`);
  const match = url.pathname.match(/^\/v1\/connectors\/([^/]+)\/(health|schema|records(?:\/([^/]+))?)$/);
  if (!match || decodeURIComponent(match[1]) !== 'nava-demo') {
    return json(response, 404, { ok: false, error: 'Connector not found.' }, origin);
  }
  const resource = match[2];
  if (resource === 'health') {
    return json(response, 200, { ok: true, provider: 'apricot360', organizationName: 'Riverside Community Services', mode: 'local-demo' }, origin);
  }
  if (resource === 'schema') {
    if ((url.searchParams.get('sourceId') || url.searchParams.get('formId')) !== '99') return json(response, 404, { ok: false, error: 'Source not found.' }, origin);
    return json(response, 200, { ok: true, fields: schema }, origin);
  }
  if ((url.searchParams.get('sourceId') || url.searchParams.get('formId')) !== '99') {
    return json(response, 404, { ok: false, error: 'Source not found.' }, origin);
  }
  const recordId = decodeURIComponent(match[3] || '');
  const record = records[recordId];
  return json(response, record ? 200 : 404, record || { ok: false, error: 'Record not found.' }, origin);
});

server.listen(port, '127.0.0.1', () => {
  console.log(`Nava connector mock listening on http://127.0.0.1:${port}`);
});
