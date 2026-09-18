const test = require('node:test');
const assert = require('node:assert/strict');
const engine = require('../shared/form-engine.js');

const participant = {
  record_id: '339619',
  participant: {
    name: { first: 'Celeste', middle: 'NAVA', last: 'Thomas', suffix: 'II' },
    date_of_birth: '2000-01-02',
    gender: 'Female',
    special_needs: false,
  },
  contact_information: {
    preferred_method: null,
    phones: { cell: '(951) 555-1212' },
    email: 'celeste@example.org',
  },
  address: {
    residential: {
      street: '12 Main Street',
      unit: 'Apt 3',
      city: 'Riverside',
      state: 'California',
      county: 'Riverside',
      zip: '92501',
    },
    mailing: {
      street: '12 Main Street',
      unit: 'Apt 3',
      city: 'Riverside',
      state: 'California',
      county: 'Riverside',
      zip: '92501',
    },
  },
};

test('canonicalizes the source app participant shape without inventing protected data', () => {
  const canonical = engine.canonicalizeParticipant(participant);
  assert.equal(canonical.name, 'Celeste NAVA Thomas II');
  assert.equal(canonical.values.firstName, 'Celeste');
  assert.equal(canonical.values.lastName, 'Thomas');
  assert.equal(canonical.values.suffix, 'II');
  assert.equal(canonical.values.phone, '(951) 555-1212');
  assert.equal(canonical.values.mailingDifferent, false);
  assert.equal(canonical.values.ssn, undefined);
  assert.equal(canonical.values.housingStatus, undefined);
  assert.equal(canonical.values.preferredContact, undefined);
});

test('mailing equality requires both addresses and honors common address aliases', () => {
  const missingMailing = engine.canonicalizeParticipant({
    address: { residential: { street: '12 Main Street', city: 'Riverside', state: 'CA', zip: '92501' } },
  });
  assert.equal(missingMailing.values.mailingSame, undefined);
  assert.equal(missingMailing.values.mailingDifferent, undefined);

  const matchingAliases = engine.canonicalizeParticipant({
    address: {
      residential: {
        line1: '12 Main Street',
        line2: 'Apt 3',
        city: 'Riverside',
        state: 'CA',
        postalCode: '92501',
      },
      mailing: {
        addressLine1: '12 Main Street',
        addressLine2: 'Apt 3',
        city: 'Riverside',
        state: 'CA',
        zip: '92501',
      },
    },
  });
  assert.equal(matchingAliases.values.mailingSame, true);
  assert.equal(matchingAliases.values.mailingDifferent, false);

  const differentAddresses = engine.canonicalizeParticipant({
    address: {
      residential: { street: '12 Main Street', city: 'Riverside', state: 'CA', zip: '92501' },
      mailing: { street: '99 Second Avenue', city: 'Corona', state: 'CA', zip: '92879' },
    },
  });
  assert.equal(differentAddresses.values.mailingSame, false);
  assert.equal(differentAddresses.values.mailingDifferent, true);
});

test('classifies same-address and different-address questions in the correct direction', () => {
  assert.equal(engine.classifyField({ label: 'Is the mailing address the same as home?' }), 'mailingSame');
  assert.equal(engine.classifyField({ label: 'Is your mailing address the same as your residential address?' }), 'mailingSame');
  assert.equal(engine.classifyField({ label: 'Do you get mail at a different address?' }), 'mailingDifferent');
  assert.equal(engine.classifyField({ label: 'Is your mailing address different from home?' }), 'mailingDifferent');
});

test('maps known fields, formats state/date/phone, and asks for housing status', () => {
  const fields = [
    { fieldKey: 'first', type: 'text', label: 'First Name (required)', autocomplete: 'given-name', required: true, value: '' },
    { fieldKey: 'dob', type: 'text', label: 'Date of Birth', id: 'birthDate', required: true, maxLength: 8, value: '' },
    { fieldKey: 'state', type: 'text', label: 'State', required: true, maxLength: 2, value: '' },
    { fieldKey: 'phone', type: 'tel', label: 'Telephone', required: true, maxLength: 10, value: '' },
    { fieldKey: 'housing-yes', groupKey: 'housing', type: 'radio', question: 'Are you experiencing homelessness?', optionLabel: 'Yes', label: 'Yes', value: 'yes', required: true },
    { fieldKey: 'housing-no', groupKey: 'housing', type: 'radio', question: 'Are you experiencing homelessness?', optionLabel: 'No', label: 'No', value: 'no', required: true },
  ];

  const analysis = engine.buildAnalysis(fields, participant);
  const assignments = Object.fromEntries(analysis.assignments.map((item) => [item.purpose, item]));
  assert.equal(assignments.firstName.value, 'Celeste');
  assert.equal(assignments.dateOfBirth.value, '01022000');
  assert.equal(assignments.state.value, 'CA');
  assert.equal(assignments.phone.value, '9515551212');
  assert.equal(assignments.state.source, 'changed');
  assert.equal(analysis.gaps.length, 1);
  assert.equal(analysis.gaps[0].purpose, 'housingStatus');
  assert.equal(analysis.gaps[0].kind, 'decision');
});

test('combines a Yes/No group into one question', () => {
  const fields = [
    { fieldKey: 'childcare-y', groupKey: 'childcare', type: 'radio', question: 'Is Maria paying for childcare?', optionLabel: 'Yes', label: 'Yes', value: 'Y' },
    { fieldKey: 'childcare-n', groupKey: 'childcare', type: 'radio', question: 'Is Maria paying for childcare?', optionLabel: 'No', label: 'No', value: 'N' },
  ];
  const analysis = engine.buildAnalysis(fields, {});
  assert.equal(analysis.gaps.length, 1);
  assert.equal(analysis.gaps[0].options.length, 2);
  assert.equal(analysis.gaps[0].fieldKey, 'childcare');
});

test('keeps a matching page value and does not schedule an overwrite', () => {
  const fields = [
    { fieldKey: 'first', type: 'text', label: 'First Name', autocomplete: 'given-name', required: true, value: 'Celeste' },
  ];
  const analysis = engine.buildAnalysis(fields, participant);
  assert.equal(analysis.assignments.length, 0);
  assert.equal(analysis.observed.length, 1);
  assert.equal(analysis.observed[0].source, 'page');
});

test('abstains when repeated canonical fields have no proven entity scope', () => {
  const analysis = engine.buildAnalysis([
    { fieldKey: 'person-1-first', type: 'text', label: 'First name', required: true, value: '' },
    { fieldKey: 'person-2-first', type: 'text', label: 'First name', required: true, value: '' },
    { fieldKey: 'person-1-income', type: 'text', label: 'Monthly income', required: true, value: '' },
    { fieldKey: 'person-2-income', type: 'text', label: 'Monthly income', required: true, value: '' },
  ], { ...participant, householdSize: 3, income: '1850' });

  assert.equal(analysis.assignments.length, 0);
  assert.deepEqual(analysis.gaps.map((gap) => gap.fieldKey), [
    'person-1-first',
    'person-2-first',
    'person-1-income',
    'person-2-income',
  ]);
  assert.ok(analysis.gaps.every((gap) => gap.kind === 'entity_scope' && gap.required));
  assert.ok(!analysis.noFields.some((item) => ['firstName', 'income'].includes(item.purpose)));
});

test('does not fill a blank repeated field from a matching value of unknown entity scope', () => {
  const analysis = engine.buildAnalysis([
    { fieldKey: 'person-1-first', type: 'text', label: 'First name', required: true, value: 'Celeste' },
    { fieldKey: 'person-2-first', type: 'text', label: 'First name', required: true, value: '' },
  ], participant);

  assert.equal(analysis.assignments.length, 0);
  assert.equal(analysis.observed.length, 0);
  assert.equal(analysis.gaps.length, 2);
  assert.ok(analysis.gaps.every((gap) => gap.kind === 'entity_scope'));
});

test('reuses a scalar value only for a strict confirmation pair', () => {
  const confirmation = engine.buildAnalysis([
    { fieldKey: 'email', type: 'email', label: 'Email address', value: '' },
    { fieldKey: 'confirm-email', type: 'email', label: 'Confirm email address', value: '' },
  ], participant);
  assert.deepEqual(confirmation.assignments.map((assignment) => assignment.fieldKey), ['email', 'confirm-email']);
  assert.equal(confirmation.gaps.length, 0);

  const ambiguous = engine.buildAnalysis([
    { fieldKey: 'email-1', type: 'email', label: 'Email address', value: '' },
    { fieldKey: 'email-2', type: 'email', label: 'Secondary email address', value: '' },
    { fieldKey: 'confirm-email', type: 'email', label: 'Confirm email address', value: '' },
  ], participant);
  assert.equal(ambiguous.assignments.length, 0);
  assert.equal(ambiguous.gaps.length, 3);
  assert.ok(ambiguous.gaps.every((gap) => gap.kind === 'entity_scope'));
});

test('allows a site adapter to prove that one applicant value belongs in repeated fields', () => {
  const analysis = engine.buildAnalysis([
    {
      fieldKey: 'read-language',
      type: 'select-one',
      purpose: 'primaryLanguage',
      allowRepeatedPurpose: true,
      label: 'Language for written notices',
      options: [{ value: 'English', label: 'English' }],
      value: '',
    },
    {
      fieldKey: 'speak-language',
      type: 'select-one',
      purpose: 'primaryLanguage',
      allowRepeatedPurpose: true,
      label: 'Language for spoken notices',
      options: [{ value: 'English', label: 'English' }],
      value: '',
    },
  ], { participant: { primary_language: 'English' } });

  assert.equal(analysis.gaps.length, 0);
  assert.deepEqual(analysis.assignments.map((assignment) => assignment.fieldKey), ['read-language', 'speak-language']);
});

test('compares masked values by digits during verification', () => {
  assert.equal(engine.valuesEquivalent('01022000', '01/02/2000', { type: 'date', label: 'Birth date' }), true);
  assert.equal(engine.valuesEquivalent('9515551212', '(951) 555-1212', { type: 'tel', label: 'Phone' }), true);
  assert.equal(engine.valuesEquivalent('123456789', '123-45-6780', { type: 'password', label: 'SSN' }), false);
});

test('lists client values that have no field on the current page', () => {
  const analysis = engine.buildAnalysis([
    { fieldKey: 'first', type: 'text', label: 'First Name', autocomplete: 'given-name', value: '' },
  ], participant);
  assert.ok(analysis.noFields.some((item) => item.purpose === 'email'));
  assert.ok(analysis.noFields.some((item) => item.purpose === 'postalCode'));
});

test('maps business fields, masks EIN provenance, and formats a business address', () => {
  const business = {
    businessName: 'Juniper Bicycle Works LLC',
    ein: '12-3456789',
    businessType: 'Limited Liability Company',
    businessAddressLine1: '4400 Mission Boulevard',
    businessAddressLine2: 'Suite 12',
    businessCity: 'San Diego',
    businessState: 'California',
    businessPostalCode: '92109',
  };
  const analysis = engine.buildAnalysis([
    { fieldKey: 'legal-name', type: 'text', label: 'Business Legal Name', value: '' },
    { fieldKey: 'ein', type: 'text', label: 'Employer Identification Number', value: '' },
    { fieldKey: 'address', type: 'text', label: 'Business Address', value: '' },
    { fieldKey: 'state', type: 'text', label: 'Business State', maxLength: 2, value: '' },
  ], business);
  const assignments = Object.fromEntries(analysis.assignments.map((item) => [item.purpose, item]));

  assert.equal(assignments.businessName.value, 'Juniper Bicycle Works LLC');
  assert.equal(assignments.ein.sensitive, true);
  assert.equal(assignments.businessAddressLine1.value, '4400 Mission Boulevard, Suite 12');
  assert.equal(assignments.businessState.value, 'CA');
});

test('formats a labeled US-style document date for a date input', () => {
  const analysis = engine.buildAnalysis([
    { fieldKey: 'dob', type: 'date', label: 'Date of Birth', value: '' },
  ], { dateOfBirth: '7/8/1992' });

  assert.equal(analysis.assignments[0].value, '1992-07-08');
  assert.equal(analysis.assignments[0].source, 'changed');
});

test('maps the caseworker-selected BenefitsCal programs explicitly', () => {
  const analysis = engine.buildAnalysis([
    { fieldKey: 'calfresh', groupKey: 'group:checkbox:programs', type: 'checkbox', label: 'CalFresh', optionLabel: 'CalFresh', value: '' },
    { fieldKey: 'medical', groupKey: 'group:checkbox:programs', type: 'checkbox', label: 'Medi-Cal', optionLabel: 'Medi-Cal', value: '' },
    { fieldKey: 'calworks', groupKey: 'group:checkbox:programs', type: 'checkbox', label: 'CalWORKs', optionLabel: 'CalWORKs', value: '' },
  ], {
    applicationSelection: { calfresh: true, medical: false, calworks: true },
  });
  const assignments = Object.fromEntries(analysis.assignments.map((item) => [item.purpose, item.value]));
  assert.deepEqual(assignments, {
    applyCalFresh: 'yes',
    applyCalWORKs: 'yes',
  });
  assert.ok(analysis.observed.some((item) => item.fieldKey === 'medical' && item.value === 'no'));
});
