const test = require('node:test');
const assert = require('node:assert/strict');
const connector = require('../shared/connector-engine.js');
const form = require('../shared/form-engine.js');

const canonicalKeys = [
  'firstName', 'middleName', 'lastName', 'dateOfBirth', 'ssn',
  'email', 'phone', 'addressLine1', 'addressLine2', 'city', 'state', 'county', 'postalCode', 'country',
  'primaryLanguage', 'gender', 'ethnicity', 'maritalStatus', 'specialNeeds', 'farmWorker', 'pregnant',
  'preferredContact', 'housingStatus', 'householdSize', 'immigrationStatus',
  'income', 'childcare', 'unemployment',
];

const schema = canonicalKeys.map((key, index) => ({
  id: index + 101,
  label: connector.CANONICAL_FIELDS.find((field) => field.key === key).label,
  reference_tag: key,
}));

const sourceValues = {
  firstName: 'Celeste', middleName: 'NAVA', lastName: 'Thomas II', dateOfBirth: '2000-01-02', ssn: '123-45-6789',
  email: 'testnava@email.com', phone: '777-777-7777', addressLine1: '5556 Test Blvd', addressLine2: 'Apt 556',
  city: 'WILDOMAR', state: 'California', county: 'Riverside', postalCode: '92595', country: 'United States',
  primaryLanguage: 'English', gender: 'Female', ethnicity: 'Hispanic/Latino', maritalStatus: 'Single',
  specialNeeds: false, farmWorker: false, pregnant: false, preferredContact: 'Email', housingStatus: 'Stable housing',
  householdSize: '3', immigrationStatus: 'U.S. citizen', income: '1850', childcare: true, unemployment: false,
};

const rawAttributes = Object.fromEntries(schema.map((field, index) => [`field_${field.id}`, sourceValues[canonicalKeys[index]]]));

function yesNo(groupKey, question) {
  return [
    { fieldKey: `${groupKey}:yes`, groupKey, type: 'radio', question, label: 'Yes', optionLabel: 'Yes', value: 'yes', required: true },
    { fieldKey: `${groupKey}:no`, groupKey, type: 'radio', question, label: 'No', optionLabel: 'No', value: 'no', required: true },
  ];
}

const pages = [
  [
    { fieldKey: 'first', type: 'text', label: 'First name', autocomplete: 'given-name', required: true, value: '' },
    { fieldKey: 'middle', type: 'text', label: 'Middle name', autocomplete: 'additional-name', value: '' },
    { fieldKey: 'last', type: 'text', label: 'Last name', autocomplete: 'family-name', required: true, value: '' },
    { fieldKey: 'dob', type: 'text', label: 'Date of birth', maxLength: 10, required: true, value: '' },
    { fieldKey: 'ssn', type: 'text', label: 'Social Security Number', maxLength: 11, required: true, value: '', sensitive: true },
  ],
  [
    { fieldKey: 'email', type: 'email', label: 'Email', required: true, value: '' },
    { fieldKey: 'phone', type: 'tel', label: 'Mobile phone', maxLength: 10, required: true, value: '' },
    { fieldKey: 'street', type: 'text', label: 'Street address', autocomplete: 'address-line1', required: true, value: '' },
    { fieldKey: 'unit', type: 'text', label: 'Apartment or unit', autocomplete: 'address-line2', value: '' },
    { fieldKey: 'city', type: 'text', label: 'City', autocomplete: 'address-level2', required: true, value: '' },
    { fieldKey: 'state', type: 'text', label: 'State', autocomplete: 'address-level1', maxLength: 2, required: true, value: '' },
    { fieldKey: 'county', type: 'text', label: 'County', required: true, value: '' },
    { fieldKey: 'zip', type: 'text', label: 'ZIP code', autocomplete: 'postal-code', maxLength: 5, required: true, value: '' },
    { fieldKey: 'country', type: 'text', label: 'Country', autocomplete: 'country-name', required: true, value: '' },
  ],
  [
    { fieldKey: 'language', type: 'select-one', label: 'Primary language', required: true, value: '', options: [{ value: 'English', label: 'English' }] },
    { fieldKey: 'gender', type: 'select-one', label: 'GenderChooseFemaleMaleNonbinary', required: true, value: '', options: [{ value: 'Female', label: 'Female' }] },
    { fieldKey: 'ethnicity', type: 'select-one', label: 'Ethnicity', required: true, value: '', options: [{ value: 'Hispanic/Latino', label: 'Hispanic/Latino' }] },
    { fieldKey: 'marital', type: 'select-one', label: 'Marital status', required: true, value: '', options: [{ value: 'Single', label: 'Single' }] },
    ...yesNo('special-needs', 'Does the applicant have special needs or a disability?'),
    ...yesNo('farm-worker', 'Is the applicant a farm worker?'),
    ...yesNo('pregnant', 'Is the applicant pregnant?'),
  ],
  [
    { fieldKey: 'contact', type: 'select-one', label: 'Preferred contact method', required: true, value: '', options: [{ value: 'Email', label: 'Email' }] },
    { fieldKey: 'housing', type: 'select-one', label: 'Housing status', required: true, value: '', options: [{ value: 'Stable housing', label: 'Stable housing' }] },
    { fieldKey: 'household', type: 'number', label: 'Household size', required: true, value: '' },
    { fieldKey: 'citizenship', type: 'select-one', label: 'Citizenship status', required: true, value: '', sensitive: true, options: [{ value: 'U.S. citizen', label: 'U.S. citizen' }] },
  ],
  [
    { fieldKey: 'income', type: 'text', label: 'Monthly household income', required: true, value: '', sensitive: true },
    ...yesNo('childcare', 'Is the household paying for childcare?'),
    ...yesNo('unemployment', 'Does the applicant receive unemployment benefits?'),
  ],
];

test('maps 28 explicitly labeled source fields into a production-like benefits flow with no invented values', () => {
  const mappings = connector.suggestMappings(schema);
  assert.equal(Object.keys(mappings).length, canonicalKeys.length);
  const mapped = connector.mapRecord({
    data: [{ id: '339619', attributes: { ...rawAttributes, mod_time: '2026-09-16T12:00:00.000Z' } }],
  }, {
    provider: 'apricot360',
    organizationName: 'Fictional Human Services',
    backendUrl: 'https://connectors.example.org',
    connectionId: 'fictional-apricot',
    sourceId: '99',
    mappings,
  }, schema, '2026-09-16T13:00:00.000Z');

  assert.equal(mapped.found, true);
  const analyses = pages.map((fields) => form.buildAnalysis(fields, mapped.record));
  const assignments = analyses.flatMap((analysis) => analysis.assignments);
  const gaps = analyses.flatMap((analysis) => analysis.gaps);
  const purposes = new Set(assignments.map((assignment) => assignment.purpose));

  assert.equal(assignments.length, 28);
  assert.equal(purposes.size, 28);
  assert.equal(gaps.length, 0);
  assert.equal(assignments.find((item) => item.purpose === 'state').value, 'CA');
  assert.equal(assignments.find((item) => item.purpose === 'phone').value, '7777777777');
  assert.equal(assignments.find((item) => item.purpose === 'ssn').sensitive, true);
  assert.equal(assignments.find((item) => item.purpose === 'income').value, '1850');
  assert.equal(assignments.find((item) => item.purpose === 'unemployment').value, 'no');
});

test('missing protected and eligibility values become questions instead of guesses', () => {
  const analysis = form.buildAnalysis([
    { fieldKey: 'ssn', type: 'text', label: 'Social Security Number', required: true, value: '', sensitive: true },
    { fieldKey: 'income', type: 'text', label: 'Monthly household income', required: true, value: '', sensitive: true },
    { fieldKey: 'citizenship', type: 'select-one', label: 'Citizenship status', required: true, value: '', options: [{ value: 'Citizen', label: 'Citizen' }] },
  ], { firstName: 'Fictional' });

  assert.deepEqual(analysis.assignments, []);
  assert.deepEqual(analysis.gaps.map((gap) => gap.purpose), ['ssn', 'income', 'immigrationStatus']);
});
