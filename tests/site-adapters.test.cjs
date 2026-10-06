const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const adapters = require('../shared/site-adapters.js');
const engine = require('../shared/form-engine.js');
const demoConnectorData = require('../shared/demo-connector-data.js');

const IHSS_HOST = 'riversideihss.org';
const IHSS_PATH = '/IntakeApp';
const WIC_HOST = 'www.ruhealth.org';
const WIC_PATH = '/appointments/apply-4-wic-form';

function withPolicy(hostname, pathname, field) {
  const policy = adapters.fieldPolicy(hostname, pathname, field);
  return policy ? { ...field, ...policy } : { ...field };
}

/** A bundled fictional client record, as the service worker's demo connector serves it from the shared demo data. */
function demoRecord(recordId = '339619') {
  assert.ok(Array.isArray(demoConnectorData.CLIENT_RECORDS), 'shared demo client records should be declared');
  return structuredClone(demoConnectorData.CLIENT_RECORDS.find((record) => record.record_id === recordId));
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
  const category = adapters.fieldPolicy(WIC_HOST, WIC_PATH, { id: 'edit-please-select-all-that-apply-childrentoddler-0-5' });
  const appointment = adapters.fieldPolicy(WIC_HOST, WIC_PATH, { id: 'edit-i-authorize-my-wic-appointments-select-all-that-apply-in-person' });
  assert.equal(category.decisionGroupKey, 'wic:applicant-category');
  assert.equal(category.decisionGroupQuestion, 'Please select all that apply');
  assert.equal(appointment.decisionGroupKey, 'wic:appointment-methods');
  assert.match(appointment.decisionGroupQuestion, /appointment methods/i);
});

test('the complete observed WIC form maps every fictional source-backed answer with no false gaps', () => {
  const field = (id, type, label, extra = {}) => withPolicy(WIC_HOST, WIC_PATH, {
    fieldKey: id,
    id,
    name: id,
    type,
    label,
    optionLabel: label,
    value: '',
    checked: false,
    ...extra,
  });
  const fields = [
    field('edit-name', 'text', 'Name'),
    field('edit-date-of-birth', 'text', 'Date of Birth', { required: true, pattern: '\\d{1,2}/\\d{1,2}/\\d{4}' }),
    field('edit-home-address', 'text', 'Home Address', { required: true }),
    field('edit-mailing-address-if-different-from-home-address-', 'text', 'Mailing address (if different from home address)'),
    field('edit-mobile', 'tel', 'Mobile Number', { required: true, pattern: '^\\(\\d{3}\\)\\s\\d{3}-\\d{4}' }),
    field('edit-can-you-receive-text-messages-yes', 'radio', 'Yes', { question: 'Can you receive text messages', optionValue: 'Yes', required: true }),
    field('edit-can-you-receive-text-messages-no', 'radio', 'No', { question: 'Can you receive text messages', optionValue: 'No', required: true }),
    field('edit-email', 'email', 'Email'),
    field('edit-what-is-your-preferred-language', 'select-one', 'What is your preferred language', {
      options: [{ value: 'English ', label: 'English' }, { value: 'Spanish ', label: 'Spanish' }, { value: 'Other', label: 'Other' }],
    }),
    field('edit-do-you-have-medical-yes', 'radio', 'Yes', { question: 'Do you have MediCal', optionValue: 'Yes', required: true }),
    field('edit-do-you-have-medical-no', 'radio', 'No', { question: 'Do you have MediCal', optionValue: 'No', required: true }),
    field('edit-do-you-have-medical-in-progress', 'radio', 'In Progress', { question: 'Do you have MediCal', optionValue: 'In Progress', required: true }),
    field('edit-if-yes', 'text', 'If yes - MediCal Case #'),
    field('edit-please-select-all-that-apply-pregnant', 'checkbox', 'Pregnant'),
    field('edit-please-select-all-that-apply-post-partum', 'checkbox', 'Post-partum'),
    field('edit-please-select-all-that-apply-infant-breastfeeding', 'checkbox', 'Infant-breastfeeding'),
    field('edit-please-select-all-that-apply-infant-formula', 'checkbox', 'Infant-formula'),
    field('edit-please-select-all-that-apply-childrentoddler-0-5', 'checkbox', 'Children/Toddler 0-5'),
    field('edit-i-authorize-my-wic-appointments-select-all-that-apply-in-person', 'checkbox', 'In-Person'),
    field('edit-i-authorize-my-wic-appointments-select-all-that-apply-virtual-phone', 'checkbox', 'Virtual (phone)'),
    field('edit-i-authorize-my-wic-appointments-select-all-that-apply-telehealth-video', 'checkbox', 'Telehealth (video)'),
    field('edit-please-choose-the-wic-clinic-closest-to-you', 'select-one', 'Please choose the WIC Clinic Closest to you', {
      options: [{ value: 'Arlanza Riverside WIC', label: 'Arlanza Riverside WIC' }, { value: 'Temecula WIC', label: 'Temecula WIC' }],
    }),
  ];
  const analysis = engine.buildAnalysis(fields, demoRecord());
  const assignments = Object.fromEntries(analysis.assignments.map((item) => [item.purpose, item.value]));

  assert.equal(analysis.gaps.length, 0);
  assert.equal(assignments.fullName, 'Celeste NAVA Thomas II');
  assert.equal(assignments.phone, '(777) 777-7777');
  assert.equal(assignments.canReceiveTexts, 'Yes');
  assert.equal(assignments.mediCalCoverage, 'No');
  assert.equal(assignments.wicChildUnderFive, 'yes');
  assert.equal(assignments.wicAppointmentInPerson, 'yes');
  assert.equal(assignments.wicClinic, 'Temecula WIC');
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

function ihss(field) {
  return adapters.fieldPolicy(IHSS_HOST, IHSS_PATH, field);
}

function choicePolicy(groupKey, purpose, question, required, optionValue) {
  return { groupKey, purpose, question, required, type: 'radio', exclusive: true, optionValue };
}

test('IHSS household rules: first-row entity ids and every repeated-row id form', () => {
  assert.deepEqual(ihss({ id: 'relationshipDrpDwn' }), { purpose: 'ihssHouseholdRelationship', required: true });
  assert.deepEqual(ihss({ id: 'nameHouseholdTxt' }), { purpose: 'ihssHouseholdMemberName', required: true });
  assert.deepEqual(ihss({ id: 'birthDateHouseholdTxt' }), { purpose: 'ihssHouseholdMemberDateOfBirth', required: true });
  assert.deepEqual(ihss({ id: 'ssnHouseholdTxt' }), { purpose: 'ihssHouseholdMemberSsn', required: true, sensitive: true });

  for (const id of ['relationshipDrpDwn2', 'nameHouseholdTxt-3', 'birthDateHouseholdTxt_4', 'ssnHouseholdTxt:12']) {
    assert.deepEqual(ihss({ id }), { unmapped: true, required: true }, `${id} is an additional household row`);
  }
  for (const id of ['ssnHouseholdTxtA', 'xnameHouseholdTxt2', 'nameHouseholdTxt-']) {
    assert.equal(ihss({ id }), null, `${id} is not a household id`);
  }
});

test('IHSS conditional-entity rules turn every representative, veteran, facility, past-service, and other-service id into a gap', () => {
  const requiredGapIds = [
    'repFirstNameTxt', 'repLastNameTxt', 'repPhoneTxt', 'ticketId2Txt', 'relToApplicantDrpDwn',
    'hppDrpDwn', 'otherHPPTxt', 'caDrpDwn', 'otherCATxt', 'otherRelTypeTxt',
    'veteranNameTxt', 'veteranClaimNumberTxt',
    'nameOfFacilityTxt', 'facilityStreetTxt', 'facilityCityTxt', 'facilityStateTxt', 'facilityZipCodeTxt', 'expectedDateOfDischargeTxt',
    'pastIHSSDateTxt', 'pastIHSSCountyTxt', 'monthlyHoursTxt', 'nameUsedTxt',
    'otherServiceRequestedTxt',
  ];
  for (const id of requiredGapIds) {
    assert.deepEqual(ihss({ id, value: 'ignored' }), { unmapped: true, required: true }, id);
  }
  assert.deepEqual(ihss({ id: 'repEmailTxt' }), { unmapped: true, required: false });
  for (const id of ['repFirstNameTxt2', 'xveteranNameTxt', 'otherServiceRequested', 'repEmailTxt2']) {
    assert.equal(ihss({ id }), null, `${id} must match exactly`);
  }

  assert.deepEqual(ihss({ id: 'chkBxApplicantAgreeYes', value: 'on' }), {
    ...choicePolicy('ihss:applicant-agrees', '', 'Does the applicant agree to apply for IHSS services?', true, 'Yes'),
    unmapped: true,
  });
  assert.deepEqual(ihss({ id: 'chkBxVeteranRelNo', value: 'on' }), {
    ...choicePolicy('ihss:veteran-relative', '', 'Is the applicant a relative of a veteran?', true, 'No'),
    unmapped: true,
  });
});

test('IHSS exact applicant ids map to applicant purposes only', () => {
  const expected = {
    firstNameTxt: { purpose: 'firstName', required: true },
    lastNameTxt: { purpose: 'lastName', required: true },
    streetTxt: { purpose: 'addressLine1', required: true },
    cityTxt: { purpose: 'city', required: true },
    stateTxt: { purpose: 'state', required: true },
    zipCodeTxt: { purpose: 'postalCode', required: true },
    ssnTxt: { purpose: 'ssn', required: true },
    birthDateTxt: { purpose: 'dateOfBirth', required: true },
    telephoneTxt: { purpose: 'phone', required: true },
    emailTxt: { purpose: 'email' },
    mailStreetTxt: { purpose: 'mailingAddressLine1', required: true },
    mailCityTxt: { purpose: 'mailingCity', required: true },
    mailStateTxt: { purpose: 'mailingState', required: true },
    mailZipCodeTxt: { purpose: 'mailingPostalCode', required: true },
    genderIdentityDrpDwn: { purpose: 'genderIdentity' },
    sexualOrientationDrpDwn: { purpose: 'sexualOrientation' },
    healthHistoryTxt: { purpose: 'ihssHealthHistory', required: true },
    ethnicDrpDwn: { purpose: 'ethnicity', required: true },
    languagePrepareToReadDrpDwn: { purpose: 'primaryLanguage', required: true, allowRepeatedPurpose: true },
    languagePrepareToSpeakDrpDwn: { purpose: 'primaryLanguage', required: true, allowRepeatedPurpose: true },
  };
  for (const [id, policy] of Object.entries(expected)) assert.deepEqual(ihss({ id }), policy, id);
  for (const id of ['firstNameTxt2', 'xssnTxt', 'SSNTXT', 'birthDate']) assert.equal(ihss({ id }), null, id);
});

test('IHSS exclusive choice groups carry their question, requiredness, and id-suffix option value', () => {
  const groups = [
    ['chkBxApplyYourself', 'Yes', 'No', 'ihss:applying-for-self', 'ihssApplyingForSelf', 'Are you applying to receive IHSS for yourself?', true],
    ['chkBxSex', 'Male', 'Female', 'ihss:sex', 'gender', 'Sex', true],
    ['chkBxAdoptedChild', 'Yes', 'No', 'ihss:adopted-child', 'ihssAdoptedMinorChild', 'Is the application for a minor adopted child?', true],
    ['chkBxMailAddress', 'Yes', 'No', 'ihss:mailing-same', 'mailingSame', 'Is the mailing address the same as above?', true],
    ['chkBxSexOrig', 'Male', 'Female', 'ihss:birth-sex', 'birthSex', 'What sex was listed on the original birth certificate?', false],
    ['chkBxVeteran', 'Yes', 'No', 'ihss:veteran', 'veteran', 'Are you a veteran?', false],
    ['chkBxSSI', 'Yes', 'No', 'ihss:ssi', 'receivesSsi', 'Do you receive SSI/SSP benefits?', false],
    ['chkBxAssistance', 'Yes', 'No', 'ihss:home-assistance', 'homeAssistanceAvailable', 'Do you have anyone available to provide assistance at home?', false],
    ['chkBxLiveAlone', 'Yes', 'No', 'ihss:lives-alone', 'livesAlone', 'Do you live alone?', false],
    ['chkBxRcvIHSSServices', 'Yes', 'No', 'ihss:household-receives-services', 'ihssHouseholdReceivesServices', 'Is anyone in your home currently receiving IHSS services?', false],
    ['chkBxPastIHSS', 'Yes', 'No', 'ihss:past-services', 'pastIhss', 'Have you received IHSS in the past?', false],
    ['chkBxBlind', 'Yes', 'No', 'ihss:blind', 'blind', 'Applicant is blind', true],
    ['chkBxVis', 'Yes', 'No', 'ihss:visually-impaired', 'visuallyImpaired', 'Applicant is visually impaired', true],
    ['chkBxVisImpaired', 'Yes', 'No', 'ihss:visually-impaired', 'visuallyImpaired', 'Applicant is visually impaired', true],
  ];
  for (const [stem, first, second, groupKey, purpose, question, required] of groups) {
    for (const option of [first, second]) {
      assert.deepEqual(
        ihss({ id: `${stem}${option}`, value: 'on' }),
        choicePolicy(groupKey, purpose, question, required, option),
        `${stem}${option}`,
      );
    }
    assert.equal(ihss({ id: `${stem}Maybe`, value: 'on' }), null, `${stem} accepts only its two suffixes`);
    assert.equal(ihss({ id: `${stem}${first}2`, value: 'on' }), null, `${stem} ids are anchored`);
  }

  assert.deepEqual(
    ihss({ id: 'chkBxLFacility', className: 'form-check  chkBxLivingArrangement', value: 'Facility' }),
    choicePolicy('ihss:living-arrangement', 'livingArrangement', 'Check your type of living arrangement', true, 'Facility'),
  );
  assert.equal(ihss({ id: 'chkBxLOther', className: 'chkBxLivingArrangementX', value: 'Other' }), null);
});

test('IHSS rule precedence is unchanged around the class-scoped living-arrangement rule', () => {
  const livingArrangement = { className: 'chkBxLivingArrangement', value: 'Independent Living' };
  assert.equal(ihss({ id: 'chkBxRcvIHSSServicesYes', ...livingArrangement }).groupKey, 'ihss:household-receives-services');
  assert.equal(ihss({ id: 'firstNameTxt', ...livingArrangement }).purpose, 'firstName');
  assert.equal(ihss({ id: 'ssnHouseholdTxt', ...livingArrangement }).purpose, 'ihssHouseholdMemberSsn');
  assert.deepEqual(ihss({ id: 'repFirstNameTxt', ...livingArrangement }), { unmapped: true, required: true });
  assert.equal(ihss({ id: 'chkBxPastIHSSYes', ...livingArrangement }).groupKey, 'ihss:living-arrangement');
  assert.equal(ihss({ id: 'chkBxBlindNo', ...livingArrangement }).groupKey, 'ihss:living-arrangement');
  assert.equal(ihss({ id: 'chkBxHealthHistory', ...livingArrangement }).groupKey, 'ihss:living-arrangement');
});

test('IHSS checkbox-value maps give each shared-id checkbox its own independent purpose', () => {
  const independent = (purpose) => ({ purpose, required: true, groupKey: '', exclusive: false });
  const expected = [
    ['chkBxHealthHistory', '95', 'ihssDailyLivingLimitations'],
    ['chkBxHealthHistory', '96', 'ihssHospiceCare'],
    ['chkBxHealthHistory', '97', 'ihssTerminalIllness'],
    ['chkBxHealthHistory', '98', 'ihssOrganTransplant'],
    ['chkBxHealthHistory', '100', 'ihssSupplementalOxygen'],
    ['chkBxHealthHistory', '101', 'ihssCancerTreatment'],
    ['chkBxIHSSService', '80', 'ihssDomesticServices'],
    ['chkBxIHSSService', '81', 'ihssPersonalCare'],
    ['chkBxIHSSService', '82', 'ihssTransportation'],
    ['chkBxIHSSService', '83', 'ihssParamedicalCare'],
    ['chkBxOther', '84', 'ihssOtherServices'],
  ];
  for (const [id, value, purpose] of expected) assert.deepEqual(ihss({ id, value }), independent(purpose), `${id}=${value}`);
  assert.deepEqual(ihss({ id: 'chkBxOther', value: 84 }), independent('ihssOtherServices'), 'numeric DOM values are compared as strings');
  for (const [id, value] of [['chkBxHealthHistory', '99'], ['chkBxHealthHistory', '80'], ['chkBxIHSSService', '95'], ['chkBxOther', '83'], ['chkBxOther', '']]) {
    assert.equal(ihss({ id, value }), null, `${id}=${value} is not a listed answer`);
  }
});

test('IHSS rules match only their own keys and return a fresh policy on every call', () => {
  for (const name of ['constructor', 'toString', 'hasOwnProperty', '__proto__', 'valueOf']) {
    assert.equal(ihss({ id: name }), null, `id ${name} is not an IHSS field`);
    assert.equal(ihss({ id: 'chkBxHealthHistory', value: name }), null, `value ${name} is not a health-history answer`);
    assert.equal(ihss({ id: 'chkBxOther', value: name }), null, `value ${name} is not an other-service answer`);
  }
  assert.equal(ihss({}), null);
  assert.equal(ihss({ id: null, value: undefined, className: null }), null);

  const first = ihss({ id: 'ssnHouseholdTxt' });
  first.purpose = 'ssn';
  first.sensitive = false;
  assert.deepEqual(ihss({ id: 'ssnHouseholdTxt' }), { purpose: 'ihssHouseholdMemberSsn', required: true, sensitive: true });
  const gap = ihss({ id: 'repFirstNameTxt' });
  gap.unmapped = false;
  assert.deepEqual(ihss({ id: 'repLastNameTxt' }), { unmapped: true, required: true });
  const choice = ihss({ id: 'chkBxSexMale' });
  choice.optionValue = 'Female';
  assert.equal(ihss({ id: 'chkBxSexMale' }).optionValue, 'Male');
});

test('IHSS rule order keeps household and conditional entities ahead of applicant ids', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '..', 'shared', 'site-adapters.js'), 'utf8');
  const rules = source.slice(source.indexOf('const IHSS_RULES = '), source.indexOf('function ihssPolicy'));
  const order = [
    'exactIdRule(IHSS_HOUSEHOLD_FIELDS)',
    'idPatternRule(IHSS_REPEATED_HOUSEHOLD_ID',
    'idSetRule(IHSS_UNMAPPED_REQUIRED_IDS',
    'exactIdRule(IHSS_UNMAPPED_OPTIONAL_FIELDS)',
    'IHSS_UNMAPPED_CHOICES.map',
    'exactIdRule(IHSS_APPLICANT_FIELDS)',
    'IHSS_APPLICANT_CHOICES.map',
    "checkboxValueRule('chkBxHealthHistory'",
    "checkboxValueRule('chkBxIHSSService'",
    "checkboxValueRule('chkBxOther'",
  ].map((marker) => rules.indexOf(marker));
  assert.ok(order.every((index) => index >= 0), 'every IHSS rule should be listed in IHSS_RULES');
  assert.deepEqual(order, [...order].sort((a, b) => a - b), 'IHSS rules must stay in PII-scoping order');
});
