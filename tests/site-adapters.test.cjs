const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const adapters = require('../shared/site-adapters.js');
const engine = require('../shared/form-engine.js');

const IHSS_HOST = 'riversideihss.org';
const IHSS_PATH = '/IntakeApp';
const WIC_HOST = 'www.ruhealth.org';
const WIC_PATH = '/appointments/apply-4-wic-form';

function withPolicy(hostname, pathname, field) {
  const policy = adapters.fieldPolicy(hostname, pathname, field);
  return policy ? { ...field, ...policy } : { ...field };
}

function demoRecord(recordId = '339619') {
  const source = fs.readFileSync(path.resolve(__dirname, '..', 'background.js'), 'utf8');
  const marker = 'const DEMO_RECORDS = [';
  const start = source.indexOf(marker);
  const endMarker = '\n];\n\nfunction demoConnectorStatus';
  const end = source.indexOf(endMarker, start);
  assert.notEqual(start, -1, 'background demo records should be declared');
  assert.notEqual(end, -1, 'background demo records should remain a pure array literal');
  const literal = source.slice(start + 'const DEMO_RECORDS = '.length, end + 2);
  const context = {};
  vm.runInNewContext(`records = ${literal}`, context);
  return structuredClone(context.records.find((record) => record.record_id === recordId));
}

function sidepanelDemoRecord(recordId = '339619') {
  const source = fs.readFileSync(path.resolve(__dirname, '..', 'sidepanel', 'sidepanel.js'), 'utf8');
  const marker = 'const DEMO_RECORDS = ';
  const start = source.indexOf(marker);
  const endMarker = '\n  };\n\n  const PREVIEW_CONNECTOR_SCHEMA';
  const end = source.indexOf(endMarker, start);
  assert.notEqual(start, -1, 'sidepanel demo records should be declared');
  assert.notEqual(end, -1, 'sidepanel demo records should remain a pure object literal');
  const literal = source.slice(start + marker.length, end + 4);
  const context = {};
  vm.runInNewContext(`records = ${literal}`, context);
  return structuredClone(context.records[recordId]);
}

test('site policies are limited to exact hosts and path-segment prefixes', () => {
  const ihss = { id: 'firstNameTxt', type: 'text' };
  const wic = { id: 'edit-mobile', type: 'tel' };

  assert.equal(adapters.fieldPolicy(IHSS_HOST, IHSS_PATH, ihss).purpose, 'firstName');
  assert.equal(adapters.fieldPolicy(WIC_HOST, WIC_PATH, wic).purpose, 'phone');
  assert.equal(adapters.fieldPolicy(`evil.${IHSS_HOST}.example`, IHSS_PATH, ihss), null);
  assert.equal(adapters.fieldPolicy(IHSS_HOST, '/IntakeApplication', ihss), null);
  assert.equal(adapters.fieldPolicy(WIC_HOST, `${WIC_PATH}-lookalike`, wic), null);
});

test('IHSS applicant fields cannot spill into household, representative, facility, or prior-service fields', () => {
  const applicantFields = [
    withPolicy(IHSS_HOST, IHSS_PATH, { fieldKey: 'applicant-dob', id: 'birthDateTxt', type: 'text', label: 'Birthdate', maxLength: 8, value: '' }),
    withPolicy(IHSS_HOST, IHSS_PATH, {
      fieldKey: 'applicant-ssn',
      id: 'ssnTxt',
      type: 'text',
      label: 'Social Security Number',
      maxLength: 9,
      value: '',
    }),
  ];
  const conditionalIds = [
    'repFirstNameTxt',
    'facilityStreetTxt',
    'facilityCityTxt',
    'facilityStateTxt',
    'facilityZipCodeTxt',
    'pastIHSSCountyTxt',
    'veteranNameTxt',
  ];
  const householdIds = ['relationshipDrpDwn', 'nameHouseholdTxt', 'birthDateHouseholdTxt', 'ssnHouseholdTxt'];
  const additionalHouseholdIds = ['nameHouseholdTxt2', 'ssnHouseholdTxt_3'];
  const conditionalFields = conditionalIds.map((id, index) => withPolicy(IHSS_HOST, IHSS_PATH, {
    fieldKey: `conditional-${index}`,
    id,
    type: 'text',
    label: id,
    value: '',
  }));
  const householdFields = householdIds.map((id, index) => withPolicy(IHSS_HOST, IHSS_PATH, {
    fieldKey: `household-${index}`,
    id,
    type: id === 'relationshipDrpDwn' ? 'select-one' : 'text',
    label: id,
    value: '',
  }));
  const additionalHouseholdFields = additionalHouseholdIds.map((id, index) => withPolicy(IHSS_HOST, IHSS_PATH, {
    fieldKey: `additional-household-${index}`,
    id,
    type: 'text',
    label: id,
    value: '',
  }));

  conditionalFields.forEach((field) => {
    assert.equal(field.unmapped, true, `${field.id} should never inherit applicant data`);
    assert.equal(field.required, true, `${field.id} should become a visible gap when shown`);
  });
  assert.deepEqual(householdFields.map((field) => field.purpose), [
    'ihssHouseholdRelationship',
    'ihssHouseholdMemberName',
    'ihssHouseholdMemberDateOfBirth',
    'ihssHouseholdMemberSsn',
  ]);
  householdFields.forEach((field) => assert.equal(field.required, true, `${field.id} should become a gap without household data`));
  assert.equal(householdFields.find((field) => field.id === 'ssnHouseholdTxt').sensitive, true);
  additionalHouseholdFields.forEach((field) => {
    assert.equal(field.unmapped, true, `${field.id} should never reuse the first member or applicant`);
    assert.equal(field.required, true, `${field.id} should become a gap when an additional row is visible`);
  });

  const scannedFields = [...applicantFields, ...conditionalFields, ...householdFields, ...additionalHouseholdFields];
  const analysis = engine.buildAnalysis(scannedFields, {
    participant: { date_of_birth: '2000-01-02', ssn: '123-45-6789' },
    address: { residential: { street: 'Applicant Street', city: 'Riverside', state: 'CA', zip: '92501' } },
  });
  assert.deepEqual(
    analysis.assignments.map((assignment) => assignment.fieldKey).sort(),
    ['applicant-dob', 'applicant-ssn'],
  );
  assert.equal(
    analysis.assignments.find((assignment) => assignment.fieldKey === 'applicant-ssn').value,
    '123456789',
  );
  assert.deepEqual(
    analysis.gaps.map((gap) => gap.fieldKey).sort(),
    [...conditionalFields, ...householdFields, ...additionalHouseholdFields].map((field) => field.fieldKey).sort(),
  );
});

test('IHSS first household row uses its own entity and live Child relationship option', () => {
  const fields = [
    withPolicy(IHSS_HOST, IHSS_PATH, {
      fieldKey: 'household-relationship',
      id: 'relationshipDrpDwn',
      type: 'select-one',
      label: 'Relationship',
      value: '',
      options: [
        { value: '53', label: 'Child' },
        { value: '55', label: 'Non-Relative' },
        { value: '54', label: 'Other Relative' },
        { value: '52', label: 'Parent' },
        { value: '79', label: 'Spouse' },
      ],
    }),
    withPolicy(IHSS_HOST, IHSS_PATH, { fieldKey: 'household-name', id: 'nameHouseholdTxt', type: 'text', label: 'Name', value: '' }),
    withPolicy(IHSS_HOST, IHSS_PATH, { fieldKey: 'household-dob', id: 'birthDateHouseholdTxt', type: 'text', label: 'Birthdate', maxLength: 8, value: '' }),
    withPolicy(IHSS_HOST, IHSS_PATH, { fieldKey: 'household-ssn', id: 'ssnHouseholdTxt', type: 'text', label: 'Social Security Number', maxLength: 9, value: '', sensitive: true }),
  ];
  const analysis = engine.buildAnalysis(fields, demoRecord());
  const assignments = Object.fromEntries(analysis.assignments.map((item) => [item.purpose, item]));

  assert.equal(assignments.ihssHouseholdRelationship.value, '53');
  assert.equal(assignments.ihssHouseholdMemberName.value, 'Jordan Testchild');
  assert.equal(assignments.ihssHouseholdMemberDateOfBirth.value, '06152018');
  assert.equal(assignments.ihssHouseholdMemberSsn.value, '987654321');
  assert.equal(assignments.ihssHouseholdMemberSsn.sensitive, true);
  assert.equal(analysis.gaps.length, 0);
});

test('IHSS conditional mailing fields use the mailing entity rather than the residential address', () => {
  const fields = [
    withPolicy(IHSS_HOST, IHSS_PATH, { fieldKey: 'mail-street', id: 'mailStreetTxt', type: 'text', label: 'Street Address', value: '' }),
    withPolicy(IHSS_HOST, IHSS_PATH, { fieldKey: 'mail-city', id: 'mailCityTxt', type: 'text', label: 'City', value: '' }),
    withPolicy(IHSS_HOST, IHSS_PATH, { fieldKey: 'mail-state', id: 'mailStateTxt', type: 'text', label: 'State', maxLength: 2, value: '' }),
    withPolicy(IHSS_HOST, IHSS_PATH, { fieldKey: 'mail-zip', id: 'mailZipCodeTxt', type: 'text', label: 'ZIP', value: '' }),
  ];
  const analysis = engine.buildAnalysis(fields, {
    address: {
      residential: { street: '1 Home Street', city: 'Riverside', state: 'CA', zip: '92501' },
      mailing: { street: '99 Mail Avenue', unit: 'Unit 4', city: 'Corona', state: 'California', zip: '92879' },
    },
  });
  const assignments = Object.fromEntries(analysis.assignments.map((item) => [item.purpose, item.value]));

  assert.deepEqual(assignments, {
    mailingAddressLine1: '99 Mail Avenue, Unit 4',
    mailingCity: 'Corona',
    mailingState: 'CA',
    mailingPostalCode: '92879',
  });
});

test('IHSS exclusive choices stay grouped while health and service booleans stay independent', () => {
  const applyingYes = adapters.fieldPolicy(IHSS_HOST, IHSS_PATH, { id: 'chkBxApplyYourselfYes', value: 'Yes' });
  const applyingNo = adapters.fieldPolicy(IHSS_HOST, IHSS_PATH, { id: 'chkBxApplyYourselfNo', value: 'No' });
  assert.equal(applyingYes.groupKey, 'ihss:applying-for-self');
  assert.equal(applyingNo.groupKey, applyingYes.groupKey);
  assert.equal(applyingYes.exclusive, true);
  assert.equal(applyingYes.required, true);
  assert.equal(applyingYes.type, 'radio');
  assert.equal(applyingYes.optionValue, 'Yes');
  assert.equal(applyingNo.optionValue, 'No');

  // The live site's sex checkboxes both expose the ambiguous DOM value "on".
  assert.equal(adapters.fieldPolicy(IHSS_HOST, IHSS_PATH, { id: 'chkBxSexMale', value: 'on' }).optionValue, 'Male');
  assert.equal(adapters.fieldPolicy(IHSS_HOST, IHSS_PATH, { id: 'chkBxSexFemale', value: 'on' }).optionValue, 'Female');
  assert.equal(adapters.fieldPolicy(IHSS_HOST, IHSS_PATH, { id: 'chkBxSexOrigFemale', value: 'Female' }).optionValue, 'Female');
  assert.equal(adapters.fieldPolicy(IHSS_HOST, IHSS_PATH, { id: 'chkBxVeteranNo', value: 'NotVeteran' }).optionValue, 'No');
  assert.equal(adapters.fieldPolicy(IHSS_HOST, IHSS_PATH, {
    id: 'chkBxLIndependent',
    className: 'chkBxLivingArrangement',
    value: 'Independent Living',
  }).optionValue, 'Independent Living');

  const householdYes = adapters.fieldPolicy(IHSS_HOST, IHSS_PATH, { id: 'chkBxRcvIHSSServicesYes', value: 'Yes' });
  assert.equal(householdYes.purpose, 'ihssHouseholdReceivesServices');
  assert.equal(householdYes.groupKey, 'ihss:household-receives-services');
  assert.notEqual(householdYes.purpose, 'pastIhss');

  const dailyLiving = adapters.fieldPolicy(IHSS_HOST, IHSS_PATH, { id: 'chkBxHealthHistory', value: '95' });
  const domesticServices = adapters.fieldPolicy(IHSS_HOST, IHSS_PATH, { id: 'chkBxIHSSService', value: '80' });
  const otherServices = adapters.fieldPolicy(IHSS_HOST, IHSS_PATH, { id: 'chkBxOther', value: '84' });
  [dailyLiving, domesticServices, otherServices].forEach((policy) => {
    assert.equal(policy.groupKey, '');
    assert.equal(policy.exclusive, false);
    assert.equal(policy.required, true);
  });
});

test('IHSS explicitly scopes the two applicant language fields to the same person', () => {
  const readLanguage = adapters.fieldPolicy(IHSS_HOST, IHSS_PATH, { id: 'languagePrepareToReadDrpDwn' });
  const spokenLanguage = adapters.fieldPolicy(IHSS_HOST, IHSS_PATH, { id: 'languagePrepareToSpeakDrpDwn' });

  assert.equal(readLanguage.purpose, 'primaryLanguage');
  assert.equal(spokenLanguage.purpose, 'primaryLanguage');
  assert.equal(readLanguage.allowRepeatedPurpose, true);
  assert.equal(spokenLanguage.allowRepeatedPurpose, true);
});

test('the fictional review record carries explicit IHSS and WIC decisions without inventing them in the mapper', () => {
  const record = demoRecord();
  const sidepanelRecord = sidepanelDemoRecord();
  assert.deepEqual(record.programData.ihss, {
    applyingForSelf: true,
    adoptedMinorChild: false,
    genderIdentity: 'Decline to state',
    birthSex: 'Female',
    sexualOrientation: 'Decline to state',
    veteran: false,
    receivesSsi: false,
    homeAssistanceAvailable: false,
    livesAlone: false,
    householdReceivesServices: false,
    householdMembers: [{
      relationship: 'Child',
      name: 'Jordan Testchild',
      dateOfBirth: '2018-06-15',
      ssn: '987-65-4321',
    }],
    livingArrangement: 'Independent Living',
    blind: false,
    visuallyImpaired: false,
    healthHistory: 'Needs help with bathing, dressing, meal preparation, and transportation.',
    dailyLivingLimitations: true,
    hospiceCare: false,
    terminalIllness: false,
    organTransplant: false,
    supplementalOxygen: false,
    cancerTreatment: false,
    domesticServices: true,
    personalCare: true,
    transportation: true,
    paramedicalCare: false,
    otherServices: false,
    pastIhss: false,
  });
  assert.deepEqual(record.programData.wic, {
    canReceiveTexts: true,
    mediCalCoverage: 'No',
    postpartum: false,
    breastfeedingInfant: false,
    formulaInfant: false,
    childUnderFive: true,
    appointmentInPerson: true,
    appointmentPhone: false,
    appointmentVideo: false,
    clinic: 'Temecula WIC',
  });

  const canonical = engine.canonicalizeParticipant(record);
  assert.equal(record.participant.name.last, 'Thomas');
  assert.equal(record.participant.name.suffix, 'II');
  assert.deepEqual(sidepanelRecord.participant.name, record.participant.name);
  assert.deepEqual(sidepanelRecord.programData.ihss.householdMembers, record.programData.ihss.householdMembers);
  assert.equal(canonical.values.lastName, 'Thomas');
  assert.equal(canonical.values.suffix, 'II');
  assert.equal(canonical.name, 'Celeste NAVA Thomas II');
  assert.equal(canonical.values.ihssApplyingForSelf, true);
  assert.equal(canonical.values.ihssAdoptedMinorChild, false);
  assert.equal(canonical.values.ihssHouseholdReceivesServices, false);
  assert.equal(canonical.values.ihssHouseholdRelationship, 'Child');
  assert.equal(canonical.values.ihssHouseholdMemberName, 'Jordan Testchild');
  assert.equal(canonical.values.ihssDailyLivingLimitations, true);
  assert.equal(canonical.values.ihssHospiceCare, false);
  assert.equal(canonical.values.ihssDomesticServices, true);
  assert.equal(canonical.values.ihssParamedicalCare, false);
  assert.equal(canonical.values.canReceiveTexts, true);
  assert.equal(canonical.values.mediCalCoverage, 'No');
  assert.equal(canonical.values.wicChildUnderFive, true);
  assert.equal(canonical.values.wicClinic, 'Temecula WIC');
});

test('WIC exclusive groups expose stable semantic option values', () => {
  const textYes = adapters.fieldPolicy(WIC_HOST, WIC_PATH, {
    id: 'edit-can-you-receive-text-messages-yes',
    value: '1',
  });
  const textNo = adapters.fieldPolicy(WIC_HOST, WIC_PATH, {
    id: 'edit-can-you-receive-text-messages-no',
    value: '0',
  });
  const mediCalPending = adapters.fieldPolicy(WIC_HOST, WIC_PATH, {
    id: 'edit-do-you-have-medical-in-progress',
    value: 'other',
  });

  assert.equal(textYes.optionValue, 'Yes');
  assert.equal(textNo.optionValue, 'No');
  assert.equal(mediCalPending.optionValue, 'In progress');
  assert.equal(adapters.fieldPolicy(WIC_HOST, WIC_PATH, { id: 'edit-if-yes' }).sensitive, true);
});

test('WIC live phone pattern is formatted and a same mailing address stays blank', () => {
  const record = demoRecord();
  const fields = [
    withPolicy(WIC_HOST, WIC_PATH, {
      fieldKey: 'mobile',
      id: 'edit-mobile',
      type: 'tel',
      label: 'Mobile Number',
      pattern: '^\\(\\d{3}\\)\\s\\d{3}-\\d{4}',
      placeholder: '(###) ###-### ',
      maxLength: 128,
      value: '',
    }),
    withPolicy(WIC_HOST, WIC_PATH, {
      fieldKey: 'mailing',
      id: 'edit-mailing-address-if-different-from-home-address-',
      type: 'text',
      label: 'Mailing address (if different from home address)',
      value: '',
    }),
  ];
  const analysis = engine.buildAnalysis(fields, record);
  const byPurpose = Object.fromEntries(analysis.assignments.map((assignment) => [assignment.purpose, assignment]));

  assert.equal(byPurpose.phone.value, '(777) 777-7777');
  assert.equal(byPurpose.phone.source, 'changed');
  assert.equal(byPurpose.alternateMailingAddress, undefined);
  assert.equal(analysis.gaps.length, 0);
});

test('WIC uses the full alternate mailing address only when it differs from home', () => {
  const record = demoRecord();
  record.address.mailing = {
    street: '99 Second Avenue',
    unit: 'Unit 4',
    city: 'Riverside',
    state: 'CA',
    zip: '92501',
  };
  const field = withPolicy(WIC_HOST, WIC_PATH, {
    fieldKey: 'mailing',
    id: 'edit-mailing-address-if-different-from-home-address-',
    type: 'text',
    label: 'Mailing address (if different from home address)',
    value: '',
  });
  const analysis = engine.buildAnalysis([field], record);

  assert.equal(analysis.assignments.length, 1);
  assert.equal(analysis.assignments[0].purpose, 'alternateMailingAddress');
  assert.equal(analysis.assignments[0].value, '99 Second Avenue, Unit 4, Riverside, CA, 92501');
});
