// Direct tests of the modules the form engine composes (purpose vocabulary and classifier, participant record,
// field values) and of how the engine loads them: as CommonJS siblings under Node and as globals in script order.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const purposes = require('../shared/form-purposes.js');
const participantRecord = require('../shared/participant-record.js');
const fieldValues = require('../shared/field-values.js');
const engine = require('../shared/form-engine.js');

const root = path.resolve(__dirname, '..');
const FORM_MODULES = ['shared/form-purposes.js', 'shared/participant-record.js', 'shared/field-values.js', 'shared/form-engine.js'];

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

/** The shared/ scripts an HTML page loads, in order, as repo-relative paths. */
function sharedScripts(htmlPath) {
  return [...read(htmlPath).matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)]
    .map((match) => path.posix.join(path.posix.dirname(htmlPath), match[1].split(/[?#]/)[0]))
    .filter((file) => file.startsWith('shared/'));
}

function inLoadOrder(files, expected) {
  const positions = expected.map((file) => files.indexOf(file));
  assert.ok(positions.every((position) => position >= 0), `missing one of ${expected.join(', ')} in ${files.join(', ')}`);
  assert.deepEqual([...positions].sort((left, right) => left - right), positions, `${expected.join(' < ')} in ${files.join(', ')}`);
}

test('the engine API keeps its keys and re-exports the module functions themselves', () => {
  assert.deepEqual(Object.keys(engine), [
    'LABELS', 'buildAnalysis', 'canonicalizeParticipant', 'classifyField', 'compact', 'formatForField', 'normalize', 'valuesEquivalent',
  ]);
  assert.equal(engine.LABELS, purposes.LABELS);
  assert.equal(engine.classifyField, purposes.classifyField);
  assert.equal(engine.compact, purposes.compact);
  assert.equal(engine.normalize, purposes.normalize);
  assert.equal(engine.canonicalizeParticipant, participantRecord.canonicalizeParticipant);
  assert.equal(engine.formatForField, fieldValues.formatForField);
  assert.equal(engine.valuesEquivalent, fieldValues.valuesEquivalent);
});

test('purpose vocabulary: the sensitive and never-derive sets are exact and every listed purpose is labeled', () => {
  assert.deepEqual([...purposes.SENSITIVE_PURPOSES], ['ssn', 'ihssHouseholdMemberSsn', 'ein']);
  assert.deepEqual([...purposes.DO_NOT_DERIVE], [
    'ssn', 'ihssHouseholdMemberSsn', 'specialNeeds', 'farmWorker', 'pregnant', 'housingStatus', 'preferredContact',
    'householdSize', 'immigrationStatus', 'income', 'childcare', 'unemployment', 'ein', 'wicPostpartum',
    'wicBreastfeedingInfant', 'wicFormulaInfant', 'wicChildUnderFive', 'wicAppointmentInPerson', 'wicAppointmentPhone',
    'wicAppointmentVideo',
  ]);
  purposes.SENSITIVE_PURPOSES.forEach((purpose) => assert.ok(purposes.DO_NOT_DERIVE.has(purpose), `${purpose} is never derived`));
  [...purposes.SENSITIVE_PURPOSES, ...purposes.DO_NOT_DERIVE, ...purposes.YES_NO_PURPOSES]
    .forEach((purpose) => assert.ok(Object.hasOwn(purposes.LABELS, purpose), `${purpose} has a label`));
  assert.equal(new Set(purposes.YES_NO_PURPOSES).size, purposes.YES_NO_PURPOSES.length);
  ['pregnant', 'mailingSame', 'applyCalFresh', 'wicAppointmentVideo'].forEach((purpose) => assert.ok(purposes.YES_NO_PURPOSES.includes(purpose)));
});

test('normalize folds accents, case and punctuation, and compact also drops the spaces', () => {
  assert.equal(purposes.normalize('  Teléfono / E-mail '), 'telefono e mail');
  assert.equal(purposes.compact('  Teléfono / E-mail '), 'telefonoemail');
  assert.equal(purposes.normalize(null), '');
  assert.equal(purposes.normalize(undefined), '');
});

test('classifier rules run in order, so the first matching rule wins', () => {
  const cases = [
    ['Business address line 2', 'businessAddressLine2'],
    ['Business address', 'businessAddressLine1'],
    ['Street address apartment', 'addressLine2'],
    ['Home address', 'addressLine1'],
    ['Mailing address is the same as home address', 'mailingSame'],
    ['Email or phone', 'email'],
    ['Gender identity', 'genderIdentity'],
    ['Sex assigned at birth', 'birthSex'],
    ['Gender', 'gender'],
    ['State of formation', 'stateOfFormation'],
    ['Employer identification number', 'ein'],
    ['Social security number', 'ssn'],
    ['Full name of organization', null],
    ['Case number', null],
  ];
  cases.forEach(([label, purpose]) => assert.equal(purposes.classifyField({ label }), purpose, label));

  assert.equal(purposes.classifyField({ label: 'Mobile', type: 'checkbox' }), null);
  assert.equal(purposes.classifyField({ label: 'Mobile', type: 'tel' }), 'phone');
  assert.equal(purposes.classifyField({ label: 'Mobile' }), 'phone');
  assert.equal(purposes.classifyField({ autocomplete: 'given-name' }), 'firstName');
  assert.equal(purposes.classifyField({ unmapped: true, purpose: 'ssn', label: 'Email' }), null);
  assert.equal(purposes.classifyField({ purpose: 'ssn', label: 'Email' }), 'ssn');
  assert.equal(purposes.classifyField({ purpose: 'notAPurpose', label: 'Email' }), 'email');
});

test('participant record: values follow the source-path table order and carry the engine labels', () => {
  const participant = participantRecord.canonicalizeParticipant({});
  assert.equal(participant.labels, engine.LABELS);
  assert.equal(participant.labels, purposes.LABELS);
  assert.deepEqual(Object.keys(participant.values), [
    'recordId', 'firstName', 'middleName', 'lastName', 'suffix', 'fullName', 'dateOfBirth', 'ssn', 'email', 'phone',
    'addressLine1', 'addressLine2', 'city', 'state', 'county', 'postalCode', 'country', 'gender', 'genderIdentity',
    'birthSex', 'sexualOrientation', 'ethnicity', 'primaryLanguage', 'maritalStatus', 'specialNeeds', 'farmWorker',
    'pregnant', 'preferredContact', 'housingStatus', 'householdSize', 'immigrationStatus', 'income', 'childcare',
    'unemployment', 'applyCalFresh', 'applyMediCal', 'applyCalWORKs', 'mailingDifferent', 'mailingSame',
    'alternateMailingAddress', 'mailingAddressLine1', 'mailingAddressLine2', 'mailingCity', 'mailingState',
    'mailingPostalCode', 'veteran', 'receivesSsi', 'homeAssistanceAvailable', 'livesAlone', 'livingArrangement', 'blind',
    'visuallyImpaired', 'ihssApplyingForSelf', 'ihssAdoptedMinorChild', 'ihssHouseholdReceivesServices',
    'ihssHouseholdRelationship', 'ihssHouseholdMemberName', 'ihssHouseholdMemberDateOfBirth', 'ihssHouseholdMemberSsn',
    'ihssHealthHistory', 'ihssDailyLivingLimitations', 'ihssHospiceCare', 'ihssTerminalIllness', 'ihssOrganTransplant',
    'ihssSupplementalOxygen', 'ihssCancerTreatment', 'ihssDomesticServices', 'ihssPersonalCare', 'ihssTransportation',
    'ihssParamedicalCare', 'ihssOtherServices', 'pastIhss', 'canReceiveTexts', 'mediCalCoverage', 'mediCalCaseNumber',
    'wicPostpartum', 'wicBreastfeedingInfant', 'wicFormulaInfant', 'wicChildUnderFive', 'wicAppointmentInPerson',
    'wicAppointmentPhone', 'wicAppointmentVideo', 'wicClinic', 'businessName', 'dba', 'ein', 'businessType',
    'businessAddressLine1', 'businessAddressLine2', 'businessCity', 'businessState', 'businessPostalCode', 'businessPhone',
    'businessEmail', 'incorporationDate', 'stateOfFormation',
  ]);
  Object.keys(participant.values).forEach((purpose) => assert.ok(Object.hasOwn(purposes.LABELS, purpose), `${purpose} has a label`));
  assert.ok(Object.values(participant.values).every((value) => value === undefined));
  assert.equal(participant.name, 'Client');
});

test('participant record: the first non-empty path wins, 0 and false are values, and derived values are composed', () => {
  assert.equal(participantRecord.hasValue(0), true);
  assert.equal(participantRecord.hasValue(false), true);
  assert.equal(participantRecord.hasValue(''), false);
  assert.equal(participantRecord.hasValue(null), false);
  assert.equal(participantRecord.hasValue(undefined), false);

  const person = participantRecord.canonicalizeParticipant({
    firstName: '',
    first_name: 'Celeste',
    participant: { name: { first: 'Ignored', middle: 'NAVA', last: 'Thomas', suffix: 'II' } },
    householdSize: 0,
    pregnant: false,
    address: {
      residential: { street: '5556 Test Blvd', unit: 'Apt 556', city: 'Wildomar', state: 'CA', zip: '92595' },
      mailing: { street: 'PO Box 12', city: 'Wildomar', state: 'CA', zip: '92595' },
    },
  });
  assert.equal(person.values.firstName, 'Celeste');
  assert.equal(person.values.fullName, 'Celeste NAVA Thomas II');
  assert.equal(person.name, 'Celeste NAVA Thomas II');
  assert.equal(person.values.householdSize, 0);
  assert.equal(person.values.pregnant, false);
  assert.equal(person.values.mailingSame, false);
  assert.equal(person.values.mailingDifferent, true);
  assert.equal(person.values.alternateMailingAddress, 'PO Box 12, Wildomar, CA, 92595');

  const business = participantRecord.canonicalizeParticipant({
    businessName: 'Juniper Bicycle Works LLC',
    businessAddress: { street: '4400 Mission Boulevard', city: 'San Diego', state: 'CA', zip: '92109' },
  });
  assert.equal(business.name, 'Juniper Bicycle Works LLC');
  assert.equal(business.values.businessAddressLine1, '4400 Mission Boulevard');
  assert.equal(business.values.addressLine1, '4400 Mission Boulevard');
  assert.equal(business.values.postalCode, '92109');
  assert.equal(business.values.mailingSame, undefined);
});

test('field values: each formatter reshapes a record value into the shape the field asks for', () => {
  const format = (purpose, value, field, context = {}) => fieldValues.formatForField(purpose, value, field, context);

  assert.deepEqual(format('state', 'California', { type: 'text', maxLength: 2 }),
    { value: 'CA', changed: true, detail: 'California becomes CA — the form wants the state code' });
  assert.equal(format('state', 'California', { type: 'text' }).value, 'California');
  assert.deepEqual(format('dateOfBirth', '2000-01-02', { type: 'date' }),
    { value: '2000-01-02', changed: false, detail: 'from the client record' });
  assert.equal(format('dateOfBirth', '1/2/2000', { type: 'text', maxLength: 8 }).value, '01022000');
  assert.equal(format('dateOfBirth', '1/2/2000', { type: 'text' }).value, '01/02/2000');
  assert.equal(format('phone', '951-555-1212', { type: 'tel', pattern: '\\(\\d{3}\\) \\d{3}-\\d{4}' }).value, '(951) 555-1212');
  assert.equal(format('phone', '(951) 555-1212', { type: 'tel', maxLength: 10 }).value, '9515551212');
  assert.equal(format('ssn', '123-45-6789', { type: 'text', maxLength: 9 }).value, '123456789');
  assert.equal(format('ssn', '123-45-6789', { type: 'text' }).value, '123-45-6789');
  assert.deepEqual(format('addressLine1', '12 Main St', { type: 'text' }, { hasAddressLine2: false, addressLine2: 'Apt 3' }),
    { value: '12 Main St, Apt 3', changed: true, detail: 'Street and apartment are combined because the form has one address box' });
  assert.equal(format('addressLine1', '12 Main St', { type: 'text' }, { hasAddressLine2: true, addressLine2: 'Apt 3' }).value, '12 Main St');
  assert.equal(format('pregnant', false, { type: 'text' }).value, 'no');
  assert.deepEqual(format('pregnant', true, { type: 'select-one', options: [{ value: 'N', label: 'No' }, { value: 'Y', label: 'Yes' }] }),
    { value: 'Y', changed: true, detail: 'from the client record' });
  assert.deepEqual(format('householdSize', 3, { type: 'text' }), { value: '3', changed: false, detail: 'from the client record' });
});

test('field values: what a field holds now, and whether it holds the expected value', () => {
  assert.equal(fieldValues.currentFieldValue({ members: [{ value: 'a', checked: false }, { value: 'b', checked: true }] }), 'b');
  assert.equal(fieldValues.currentFieldValue({ members: [{ value: '', optionLabel: 'Yes', checked: true }] }), 'Yes');
  assert.equal(fieldValues.currentFieldValue({ members: [{ value: 'a', checked: false }] }), '');
  assert.equal(fieldValues.currentFieldValue({ type: 'checkbox', checked: true }), 'yes');
  assert.equal(fieldValues.currentFieldValue({ type: 'checkbox', checked: false, value: 'on' }), '');
  assert.equal(fieldValues.currentFieldValue({ type: 'text', value: 'Celeste' }), 'Celeste');
  assert.equal(fieldValues.currentFieldValue({ type: 'text' }), '');

  assert.equal(fieldValues.valuesEquivalent('Celeste', ' celeste ', { type: 'text' }), true);
  assert.equal(fieldValues.valuesEquivalent('(951) 555-1212', '9515551212', { type: 'tel' }), true);
  assert.equal(fieldValues.valuesEquivalent('(951) 555-1212', '9515551212', { type: 'text', label: 'Notes' }), false);
  assert.equal(fieldValues.valuesEquivalent('123-45-6789', '123456789', { type: 'text', label: 'Social Security Number' }), true);
  assert.equal(fieldValues.valuesEquivalent(null, '', { type: 'text' }), true);
  assert.equal(fieldValues.valuesEquivalent('x', '', { type: 'text' }), false);
});

test('every page that loads the engine loads its modules first, in dependency order', () => {
  const manifest = JSON.parse(read('manifest.json'));
  inLoadOrder(manifest.content_scripts[0].js, FORM_MODULES);
  inLoadOrder(sharedScripts('sidepanel/index.html'), FORM_MODULES);
  inLoadOrder(sharedScripts('demo/parser-test.html'), FORM_MODULES);
});

test('in script order the engine runs on the globals its modules install, and fails loudly without them', () => {
  const context = vm.createContext({});
  FORM_MODULES.forEach((file) => vm.runInContext(read(file), context, { filename: file }));
  const browserEngine = context.NavaFormEngine;
  assert.equal(browserEngine.LABELS, context.NavaFormPurposes.LABELS);
  assert.equal(browserEngine.canonicalizeParticipant, context.NavaParticipantRecord.canonicalizeParticipant);
  assert.equal(browserEngine.formatForField, context.NavaFieldValues.formatForField);

  const fields = [
    { fieldKey: 'first', type: 'text', label: 'First name', required: true },
    { fieldKey: 'state', type: 'text', label: 'State', maxLength: 2 },
    { fieldKey: 'pregnant', type: 'select-one', label: 'Are you pregnant?', options: [{ value: 'Y', label: 'Yes' }, { value: 'N', label: 'No' }] },
  ];
  const record = { firstName: 'Celeste', state: 'California', pregnant: false };
  assert.equal(JSON.stringify(browserEngine.buildAnalysis(fields, record)), JSON.stringify(engine.buildAnalysis(fields, record)));

  const withoutModules = vm.createContext({});
  assert.throws(
    () => vm.runInContext(read('shared/form-engine.js'), withoutModules, { filename: 'shared/form-engine.js' }),
    (error) => error.name === 'TypeError',
  );
  assert.equal(withoutModules.NavaFormEngine, undefined);
});
