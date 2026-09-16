const test = require('node:test');
const assert = require('node:assert/strict');
const connector = require('../shared/connector-engine.js');

const schema = [
  { id: 101, label: 'First Name', reference_tag: 'firstName' },
  { id: 102, label: 'Last Name', reference_tag: 'lastName' },
  { id: 103, label: 'Date of Birth', reference_tag: 'dateOfBirth' },
  { id: 104, label: 'Cell Phone', reference_tag: 'phone' },
  { id: 105, label: 'Social Security Number', reference_tag: 'ssn' },
];

const baseConfig = {
  provider: 'apricot360',
  organizationName: 'Riverside Community Services',
  backendUrl: 'https://connectors.example.org/',
  connectionId: 'riverside-apricot',
  formId: 99,
  maxAgeDays: 30,
};

test('sanitizes connector configuration and rejects secrets in Chrome', () => {
  const safe = connector.sanitizeConfig(baseConfig);
  assert.equal(safe.backendUrl, 'https://connectors.example.org');
  assert.equal(safe.mode, 'managed');
  assert.equal(safe.sourceId, '99');
  assert.throws(() => connector.sanitizeConfig({ ...baseConfig, clientSecret: 'never-store-this' }), /never be stored/);
  assert.throws(() => connector.sanitizeConfig({ ...baseConfig, access_token: 'never-store-this' }), /never be stored/);
  assert.throws(() => connector.sanitizeConfig({ ...baseConfig, backendUrl: 'http://connectors.example.org' }), /must use HTTPS/);
  assert.throws(() => connector.sanitizeConfig({ ...baseConfig, backendUrl: 'https://user:password@connectors.example.org' }), /Do not place credentials/);
  assert.equal(connector.sanitizeConfig({ ...baseConfig, backendUrl: 'http://127.0.0.1:4789' }).backendUrl, 'http://127.0.0.1:4789');
});

test('catalogs common nonprofit and HMIS providers without claiming a deployed adapter', () => {
  const ids = new Set(connector.PROVIDER_CATALOG.map((provider) => provider.id));
  assert.ok(ids.has('apricot360'));
  assert.ok(ids.has('salesforce_nonprofit'));
  assert.ok(ids.has('bitfocus_clarity'));
  assert.ok(ids.has('wellsky_community_services'));
  assert.ok(ids.has('eccovia_clienttrack'));
  assert.ok(ids.has('caseworthy'));
  assert.ok(ids.has('foothold_awards'));
  assert.ok(ids.has('bonterra_eto'));
  assert.equal(connector.providerDefinition('apricot360').readiness, 'demo-tested');
  assert.ok(connector.PROVIDER_CATALOG.filter((provider) => provider.id !== 'apricot360').every((provider) => provider.readiness === 'adapter-required'));
});

test('accepts provider-neutral resource and record identifiers through the managed contract', () => {
  const safe = connector.sanitizeConfig({
    provider: 'salesforce_nonprofit',
    organizationName: 'Fictional Community Services',
    backendUrl: 'https://connectors.example.org',
    connectionId: 'fictional-salesforce',
    sourceId: 'Contact.Client_Profile__c',
  });
  assert.equal(safe.provider, 'salesforce_nonprofit');
  assert.equal(safe.sourceId, 'Contact.Client_Profile__c');
  assert.equal(safe.formId, undefined);
  assert.throws(() => connector.sanitizeConfig({ ...safe, provider: 'unknown_vendor' }), /supported data-source type/);
});

test('normalizes numeric Apricot schema IDs to explicit record attribute IDs', () => {
  const normalized = connector.normalizeSchemaFields(schema);
  assert.equal(normalized[0].id, 'field_101');
  assert.equal(normalized[0].label, 'First Name');
});

test('suggests mappings from confirmed labels and reference tags, never value shape', () => {
  const suggestions = connector.suggestMappings(schema);
  assert.equal(suggestions.firstName, 'field_101');
  assert.equal(suggestions.lastName, 'field_102');
  assert.equal(suggestions.dateOfBirth, 'field_103');
  assert.equal(suggestions.phone, 'field_104');
  assert.equal(suggestions.ssn, 'field_105');

  const unlabeled = connector.suggestMappings([{ id: 900, label: 'Identifier' }]);
  assert.equal(unlabeled.ssn, undefined);
});

test('requires unique mappings backed by the loaded schema', () => {
  assert.throws(() => connector.validateMappings({ ...baseConfig, mappings: { firstName: 'field_101' } }, schema), /at least two/);
  assert.throws(() => connector.validateMappings({ ...baseConfig, mappings: { firstName: 'field_101', lastName: 'field_101' } }, schema), /only one/);
  assert.throws(() => connector.validateMappings({ ...baseConfig, mappings: { firstName: 'field_101', lastName: 'field_999' } }, schema), /not present/);
});

test('maps a raw Apricot record with field-level label provenance and freshness', () => {
  const mappings = connector.suggestMappings(schema);
  const result = connector.mapRecord({
    data: [{
      id: 339619,
      attributes: {
        mod_time: '2026-09-12T12:00:00.000Z',
        field_101: 'Celeste',
        field_102: 'Thomas II',
        field_103: '2000-01-02',
        field_104: '777-777-7777',
        field_105: '123-45-6789',
      },
    }],
  }, { ...baseConfig, mappings }, schema, '2026-09-14T12:00:00.000Z');

  assert.equal(result.found, true);
  assert.equal(result.record.record_id, '339619');
  assert.equal(result.record.firstName, 'Celeste');
  assert.equal(result.record.ssn, '123-45-6789');
  assert.equal(result.record._connector.provenance.ssn.sourceFieldId, 'field_105');
  assert.equal(result.record._connector.provenance.ssn.sourceLabel, 'Social Security Number');
  assert.equal(result.record._connector.stale, false);
});

test('flags records older than the configured freshness window', () => {
  const mappings = { firstName: 'field_101', lastName: 'field_102' };
  const result = connector.mapRecord({ data: [{ id: 1, attributes: { mod_time: '2026-01-01T00:00:00.000Z', field_101: 'Old', field_102: 'Record' } }] },
    { ...baseConfig, mappings, maxAgeDays: 30 }, schema, '2026-09-14T00:00:00.000Z');
  assert.equal(result.stale, true);
  assert.equal(result.freshness, 'stale');
});

test('treats a missing source timestamp as unknown freshness', () => {
  const mappings = { firstName: 'field_101', lastName: 'field_102' };
  const result = connector.mapRecord({ data: [{ id: 1, attributes: { field_101: 'Unknown', field_102: 'Freshness' } }] },
    { ...baseConfig, mappings }, schema, '2026-09-14T00:00:00.000Z');
  assert.equal(result.stale, true);
  assert.equal(result.freshness, 'unknown');
});
