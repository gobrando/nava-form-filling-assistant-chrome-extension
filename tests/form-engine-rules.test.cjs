const test = require('node:test');
const assert = require('node:assert/strict');
const engine = require('../shared/form-engine.js');

const classify = (label, extra = {}) => engine.classifyField({ label, ...extra });
const unchanged = (value) => ({ value, changed: false, detail: 'from the client record' });

test('classification short-circuits: unmapped stays unmapped and a known explicit purpose wins', () => {
  assert.equal(engine.classifyField({ unmapped: true, purpose: 'email', label: 'Email' }), null);
  assert.equal(engine.classifyField({ purpose: 'county', label: 'Email' }), 'county');
  assert.equal(engine.classifyField({ purpose: 'notAPurpose', label: 'Email' }), 'email');
  assert.throws(() => engine.classifyField(null), TypeError);
});

test('classification order: the more specific purpose wins when several rules match', () => {
  assert.equal(classify('Business address'), 'businessAddressLine1');
  assert.equal(classify('Business address line 2'), 'businessAddressLine2');
  assert.equal(classify('Company suite'), 'businessAddressLine2');
  assert.equal(classify('Business email'), 'businessEmail');
  assert.equal(classify('State of formation'), 'stateOfFormation');
  assert.equal(classify('Street address, apartment or unit'), 'addressLine2');
  assert.equal(classify('Street address'), 'addressLine1');
  assert.equal(classify('Email or phone'), 'email');
  assert.equal(classify('Gender identity'), 'genderIdentity');
  assert.equal(classify('Sex assigned at birth'), 'birthSex');
  assert.equal(classify('Sexual orientation'), 'sexualOrientation');
  assert.equal(classify('Gender'), 'gender');
});

test('classification of identifiers: exact EIN/SSN signals and spaced SSN mentions only', () => {
  assert.equal(engine.classifyField({ name: 'ein' }), 'ein');
  assert.equal(engine.classifyField({ id: 'SSN' }), 'ssn');
  assert.equal(classify('Federal tax ID'), 'ein');
  assert.equal(classify('Applicant SSN'), 'ssn');
  assert.equal(classify('SSN of applicant'), 'ssn');
  assert.equal(engine.classifyField({ name: 'ssnLast4' }), null);
  assert.equal(engine.classifyField({ name: 'einCheck' }), null);
});

test('classification guards: organization vetoes full name and phone needs a text-like field', () => {
  assert.equal(classify('Your name'), 'fullName');
  assert.equal(classify('Full name of the organization'), null);
  for (const type of [undefined, '', 'text', 'tel', 'phone']) assert.equal(classify('Mobile phone', { type }), 'phone');
  for (const type of ['checkbox', 'radio', 'select-one', 'email']) assert.equal(classify('Mobile phone', { type }), null);
});

test('classification of place and sex words matches whole words only', () => {
  assert.equal(classify('City'), 'city');
  assert.equal(classify('Ethnicity'), 'ethnicity');
  assert.equal(classify('County'), 'county');
  assert.equal(classify('State or province'), 'state');
  assert.equal(classify('Statement'), null);
  assert.equal(classify('Country'), 'country');
  assert.equal(classify('Sex'), 'gender');
  assert.equal(classify('Essex'), null);
  assert.equal(classify('City', { autocomplete: 'address-level2' }), 'city');
  assert.equal(classify('State', { autocomplete: 'address-level1' }), 'state');
  assert.equal(classify('Country', { autocomplete: 'country-name' }), 'country');
});

test('every canonical value has a label and an empty record yields no values', () => {
  const canonical = engine.canonicalizeParticipant({});
  assert.deepEqual(Object.keys(canonical.values).sort(), Object.keys(engine.LABELS).sort());
  assert.ok(Object.values(canonical.values).every((value) => value === undefined));
  assert.equal(canonical.name, 'Client');
  assert.equal(canonical.labels, engine.LABELS);
});

test('record source paths: the first non-empty path wins', () => {
  const { values } = engine.canonicalizeParticipant({
    phone: '',
    first_name: null,
    participant: { name: { first: 'Ada' } },
    contact_information: { phones: { cell: '(951) 555-0100', main: '(951) 555-0199' } },
    programData: { ihss: { hospiceCare: true, householdMembers: [{ name: 'Grace' }] } },
    ihss: { hospiceCare: false, blind: 'no' },
    wic: { clinic: 'Riverside' },
  });
  assert.equal(values.firstName, 'Ada');
  assert.equal(values.phone, '(951) 555-0100');
  assert.equal(values.ihssHospiceCare, true);
  assert.equal(values.blind, 'no');
  assert.equal(values.ihssHouseholdMemberName, 'Grace');
  assert.equal(values.wicClinic, 'Riverside');
});

test('derived record values: composed name, business-only address fallback, and mailing comparison', () => {
  const person = engine.canonicalizeParticipant({ firstName: 'Ada', lastName: 'Lovelace', suffix: 'II', fullName: 'Someone Else' });
  assert.equal(person.values.fullName, 'Ada Lovelace II');
  assert.equal(person.name, 'Ada Lovelace II');

  const business = engine.canonicalizeParticipant({
    businessName: 'Juniper LLC',
    businessCity: 'San Diego',
    businessAddress: { street: '4400 Mission Blvd', unit: 'Suite 12', city: 'Ignored', zip: '92109', county: 'San Diego' },
  });
  assert.equal(business.name, 'Juniper LLC');
  assert.equal(business.values.businessCity, 'San Diego');
  assert.equal(business.values.addressLine1, '4400 Mission Blvd');
  assert.equal(business.values.addressLine2, 'Suite 12');
  assert.equal(business.values.city, 'San Diego');
  assert.equal(business.values.postalCode, '92109');
  assert.equal(business.values.county, 'San Diego');

  const owner = engine.canonicalizeParticipant({ firstName: 'Ada', businessName: 'Juniper LLC', businessAddress: { street: '4400 Mission Blvd' } });
  assert.equal(owner.values.businessAddressLine1, '4400 Mission Blvd');
  assert.equal(owner.values.addressLine1, undefined);

  const moved = engine.canonicalizeParticipant({
    address: {
      residential: { street: '12 Main Street', city: 'Riverside' },
      mailing: { line1: 'PO Box 9', city: 'Corona', state: 'CA', postalCode: '92879' },
    },
  });
  assert.equal(moved.values.mailingDifferent, true);
  assert.equal(moved.values.mailingSame, false);
  assert.equal(moved.values.alternateMailingAddress, 'PO Box 9, Corona, CA, 92879');
  assert.equal(moved.values.mailingAddressLine1, 'PO Box 9');
  assert.equal(moved.values.mailingPostalCode, '92879');
});

test('value format: state codes only when the field wants a code', () => {
  assert.deepEqual(engine.formatForField('state', 'California', { maxLength: 2 }, {}), {
    value: 'CA',
    changed: true,
    detail: 'California becomes CA — the form wants the state code',
  });
  assert.equal(engine.formatForField('mailingState', 'new york', { options: [{ value: 'NY', label: 'New York' }] }, {}).value, 'NY');
  assert.deepEqual(engine.formatForField('businessState', 'California', { type: 'text' }, {}), unchanged('California'));
  assert.deepEqual(engine.formatForField('stateOfFormation', 'CA', { maxLength: 2 }, {}), unchanged('CA'));
});

test('value format: dates, phones, and SSNs take the shape the field asks for', () => {
  assert.equal(engine.formatForField('dateOfBirth', '7/8/1992', { type: 'date' }, {}).value, '1992-07-08');
  assert.equal(engine.formatForField('incorporationDate', '2000-01-02', { maxLength: 8 }, {}).value, '01022000');
  assert.deepEqual(engine.formatForField('ihssHouseholdMemberDateOfBirth', '01/02/2000', { type: 'text' }, {}), unchanged('01/02/2000'));
  assert.deepEqual(engine.formatForField('dateOfBirth', '13/40/2000', { type: 'date' }, {}), unchanged('13/40/2000'));

  assert.equal(engine.formatForField('phone', '951.555.1212', { pattern: '\\(\\d{3}\\) \\d{3}-\\d{4}' }, {}).value, '(951) 555-1212');
  assert.equal(engine.formatForField('businessPhone', '9515551212', { placeholder: '(###) ###-####' }, {}).value, '(951) 555-1212');
  assert.deepEqual(engine.formatForField('phone', '(951) 555-1212', { maxLength: 10 }, {}), {
    value: '9515551212',
    changed: true,
    detail: 'Phone punctuation is removed so the form can add its own format',
  });
  assert.deepEqual(engine.formatForField('phone', '555-1212', { type: 'tel' }, {}), unchanged('555-1212'));

  assert.equal(engine.formatForField('ssn', '123-45-6789', { maxLength: 9 }, {}).value, '123456789');
  assert.deepEqual(engine.formatForField('ihssHouseholdMemberSsn', '123-45-6789', { maxLength: 11 }, {}), unchanged('123-45-6789'));
});

test('value format: a street absorbs its own unit only when the page has no unit field for it', () => {
  const context = { addressLine2: 'Apt 3', mailingAddressLine2: 'Unit 9', businessAddressLine2: 'Suite 12' };
  assert.deepEqual(engine.formatForField('addressLine1', '12 Main', {}, context), {
    value: '12 Main, Apt 3',
    changed: true,
    detail: 'Street and apartment are combined because the form has one address box',
  });
  assert.equal(engine.formatForField('mailingAddressLine1', 'PO Box 9', {}, context).value, 'PO Box 9, Unit 9');
  assert.equal(engine.formatForField('businessAddressLine1', '4400 Mission', {}, context).value, '4400 Mission, Suite 12');
  assert.deepEqual(engine.formatForField('addressLine1', '12 Main', {}, { ...context, hasAddressLine2: true }), unchanged('12 Main'));
  assert.equal(engine.formatForField('businessAddressLine1', '4400 Mission', {}, { ...context, hasAddressLine2: true }).value, '4400 Mission, Suite 12');
});

test('value format: yes/no purposes become words, then take the matching option value', () => {
  assert.deepEqual(engine.formatForField('pregnant', false, { type: 'checkbox' }, {}), unchanged('no'));
  const select = { type: 'select-one', options: [{ value: 'Y', label: 'Yes' }, { value: 'N', label: 'No' }] };
  assert.deepEqual(engine.formatForField('veteran', true, select, {}), { value: 'Y', changed: true, detail: 'from the client record' });
  assert.deepEqual(engine.formatForField('veteran', 'no', select, {}), { value: 'N', changed: true, detail: 'from the client record' });
  assert.deepEqual(engine.formatForField('email', 'ada@example.org', { type: 'email' }, {}), unchanged('ada@example.org'));
});

test('analysis groups: radios become one choice, yes/no checkbox pairs combine, other checkbox groups stay separate', () => {
  const analysis = engine.buildAnalysis([
    { fieldKey: 'r1', groupKey: 'lang', type: 'radio', question: 'Preferred language', optionLabel: 'English', value: 'en', options: [] },
    { fieldKey: 'r2', groupKey: 'lang', type: 'radio', question: 'Preferred language', optionLabel: 'Spanish', value: 'es', options: [] },
    { fieldKey: 'c1', groupKey: 'texts', type: 'checkbox', purpose: 'canReceiveTexts', optionLabel: 'Yes', value: 'yes', options: [] },
    { fieldKey: 'c2', groupKey: 'texts', type: 'checkbox', purpose: 'canReceiveTexts', optionLabel: 'No', value: 'no', options: [] },
    { fieldKey: 'p1', groupKey: 'programs', type: 'checkbox', label: 'CalFresh', optionLabel: 'CalFresh', options: [] },
    { fieldKey: 'p2', groupKey: 'programs', type: 'checkbox', label: 'CalWORKs', optionLabel: 'CalWORKs', options: [] },
  ], { primaryLanguage: 'Spanish', canReceiveTexts: true, applicationSelection: { calfresh: true, calworks: false } });

  assert.deepEqual(analysis.assignments.map((item) => [item.fieldKey, item.purpose, item.value]), [
    ['lang', 'primaryLanguage', 'Spanish'],
    ['texts', 'canReceiveTexts', 'yes'],
    ['p1', 'applyCalFresh', 'yes'],
  ]);
  assert.deepEqual(analysis.observed.map((item) => [item.fieldKey, item.value]), [['p2', 'no']]);
  assert.equal(analysis.counts.fields, 4);
});

test('analysis purposes: overrides win, unknown overrides unmap, and required overrides skip the classifier', () => {
  const fields = [
    { fieldKey: 'a', type: 'text', label: 'Email', value: '' },
    { fieldKey: 'b', type: 'text', label: 'Nickname', value: '' },
    { fieldKey: 'c', type: 'text', label: 'City', value: '', required: true },
    { fieldKey: 'd', type: 'text', label: 'Notes', value: 'Prefers mornings' },
  ];
  const payload = { email: 'ada@example.org', firstName: 'Ada', city: 'Riverside' };

  const overridden = engine.buildAnalysis(fields, payload, { purposeOverrides: { a: 'notAPurpose', b: 'firstName' } });
  assert.deepEqual(overridden.assignments.map((item) => [item.fieldKey, item.purpose]), [['b', 'firstName'], ['c', 'city']]);
  assert.deepEqual(overridden.observed.map((item) => [item.fieldKey, item.detail]), [['d', 'Already in the form; the assistant did not change it']]);
  assert.deepEqual(overridden.noFields.map((item) => item.purpose), ['fullName', 'email']);

  const strict = engine.buildAnalysis(fields, payload, { purposeOverrides: { b: 'firstName' }, requirePurposeOverrides: true });
  assert.deepEqual(strict.assignments.map((item) => item.fieldKey), ['b']);
  assert.deepEqual(strict.gaps, [{
    fieldKey: 'c',
    label: 'City',
    question: "What is the client's city?",
    kind: 'required',
    required: true,
    inputType: 'text',
    options: [],
    sensitive: false,
  }]);
  assert.deepEqual(strict.counts, { fields: 4, ready: 2, missing: 1, unused: 3 });
});

test('analysis sensitivity: SSN and EIN purposes stay sensitive whether written, observed, or asked', () => {
  const analysis = engine.buildAnalysis([
    { fieldKey: 'ssn', type: 'text', label: 'Social Security Number', value: '' },
    { fieldKey: 'ein', type: 'text', label: 'Employer Identification Number', value: '12-3456789' },
    { fieldKey: 'member-ssn', type: 'text', purpose: 'ihssHouseholdMemberSsn', label: 'Household member SSN', value: '' },
  ], { ssn: '123-45-6789', ein: '12-3456789' });

  assert.deepEqual(analysis.assignments.map((item) => [item.fieldKey, item.sensitive]), [['ssn', true]]);
  assert.deepEqual(analysis.observed.map((item) => [item.fieldKey, item.sensitive]), [['ein', true]]);
  assert.deepEqual(analysis.gaps.map((gap) => [gap.fieldKey, gap.kind, gap.sensitive]), [['member-ssn', 'decision', true]]);
});
