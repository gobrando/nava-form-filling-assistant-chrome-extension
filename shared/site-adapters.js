(function installSiteAdapters(root) {
  'use strict';

  function hostMatches(hostname, domain) {
    const host = String(hostname || '').toLowerCase();
    return host === domain || host.endsWith(`.${domain}`);
  }

  function pathMatchesPrefix(pathname, prefix) {
    const path = String(pathname || '');
    return path === prefix || path.startsWith(`${prefix}/`);
  }

  function exclusiveGroup(groupKey, purpose, question, required = false, optionValue = '') {
    return { groupKey, purpose, question, required, type: 'radio', exclusive: true, optionValue };
  }

  function hasOwn(table, key) {
    return Object.prototype.hasOwnProperty.call(table, key);
  }

  // IHSS rule kinds. Each rule reads the scoped field ({ id, value, className })
  // and returns a fresh policy object, or null when the rule does not apply.

  function exactIdRule(policiesById) {
    return (field) => (hasOwn(policiesById, field.id) ? { ...policiesById[field.id] } : null);
  }

  function idPatternRule(pattern, policy) {
    return (field) => (pattern.test(field.id) ? { ...policy } : null);
  }

  function idSetRule(ids, policy) {
    return (field) => (ids.has(field.id) ? { ...policy } : null);
  }

  // An exclusive checkbox pair whose id suffix (Yes/No, Male/Female) is the
  // semantic option value; the live DOM values are ambiguous (both sex boxes
  // report "on"). A class-scoped group uses each checkbox's own DOM value.
  function choiceRule({ pattern, className, groupKey, purpose, question, required, unmapped = false }) {
    return (field) => {
      const optionValue = className ? classOptionValue(field, className) : pattern.exec(field.id)?.[1];
      if (optionValue === undefined) return null;
      const policy = exclusiveGroup(groupKey, purpose, question, required, optionValue);
      return unmapped ? { ...policy, unmapped: true } : policy;
    };
  }

  function classOptionValue(field, className) {
    return field.className.split(/\s+/).includes(className) ? field.value : undefined;
  }

  // One checkbox id shared by independent yes/no answers, told apart by value.
  // An unlisted value yields no policy.
  function checkboxValueRule(id, purposesByValue) {
    return (field) => {
      if (field.id !== id || !hasOwn(purposesByValue, field.value)) return null;
      return { purpose: purposesByValue[field.value], required: true, groupKey: '', exclusive: false };
    };
  }

  // Household values are deliberately scoped to the first household-member
  // entity. They must never inherit applicant-level name, birthdate, or SSN.
  const IHSS_HOUSEHOLD_FIELDS = Object.freeze({
    relationshipDrpDwn: { purpose: 'ihssHouseholdRelationship', required: true },
    nameHouseholdTxt: { purpose: 'ihssHouseholdMemberName', required: true },
    birthDateHouseholdTxt: { purpose: 'ihssHouseholdMemberDateOfBirth', required: true },
    ssnHouseholdTxt: { purpose: 'ihssHouseholdMemberSsn', required: true, sensitive: true },
  });

  // Additional household rows have no source entity, so they become gaps
  // instead of reusing the first member or the applicant.
  const IHSS_REPEATED_HOUSEHOLD_ID = /^(?:relationshipDrpDwn|nameHouseholdTxt|birthDateHouseholdTxt|ssnHouseholdTxt)[-_:]?\d+$/;

  // Visible conditional entity fields must surface as gaps instead of
  // inheriting applicant values or disappearing from the review. Hidden
  // controls are omitted by the scanner and will be reconsidered on rescan.
  const IHSS_UNMAPPED_REQUIRED_IDS = new Set([
    // Authorized representative and the applicant's relationship details
    'repFirstNameTxt',
    'repLastNameTxt',
    'repPhoneTxt',
    'ticketId2Txt',
    'relToApplicantDrpDwn',
    'hppDrpDwn',
    'otherHPPTxt',
    'caDrpDwn',
    'otherCATxt',
    'otherRelTypeTxt',
    // Veteran
    'veteranNameTxt',
    'veteranClaimNumberTxt',
    // Facility
    'nameOfFacilityTxt',
    'facilityStreetTxt',
    'facilityCityTxt',
    'facilityStateTxt',
    'facilityZipCodeTxt',
    'expectedDateOfDischargeTxt',
    // Past IHSS
    'pastIHSSDateTxt',
    'pastIHSSCountyTxt',
    'monthlyHoursTxt',
    'nameUsedTxt',
    // Other requested service
    'otherServiceRequestedTxt',
  ]);

  const IHSS_UNMAPPED_OPTIONAL_FIELDS = Object.freeze({
    repEmailTxt: { unmapped: true, required: false },
  });

  // Required decisions with no source field: they always become gaps.
  const IHSS_UNMAPPED_CHOICES = Object.freeze([
    { pattern: /^chkBxApplicantAgree(Yes|No)$/, groupKey: 'ihss:applicant-agrees', purpose: '', question: 'Does the applicant agree to apply for IHSS services?', required: true },
    { pattern: /^chkBxVeteranRel(Yes|No)$/, groupKey: 'ihss:veteran-relative', purpose: '', question: 'Is the applicant a relative of a veteran?', required: true },
  ]);

  const IHSS_APPLICANT_FIELDS = Object.freeze({
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
  });

  // Applicant decisions, in evaluation order. The living-arrangement class rule
  // keeps its original position between the household-services and past-IHSS pairs.
  const IHSS_APPLICANT_CHOICES = Object.freeze([
    { pattern: /^chkBxApplyYourself(Yes|No)$/, groupKey: 'ihss:applying-for-self', purpose: 'ihssApplyingForSelf', question: 'Are you applying to receive IHSS for yourself?', required: true },
    { pattern: /^chkBxSex(Male|Female)$/, groupKey: 'ihss:sex', purpose: 'gender', question: 'Sex', required: true },
    { pattern: /^chkBxAdoptedChild(Yes|No)$/, groupKey: 'ihss:adopted-child', purpose: 'ihssAdoptedMinorChild', question: 'Is the application for a minor adopted child?', required: true },
    { pattern: /^chkBxMailAddress(Yes|No)$/, groupKey: 'ihss:mailing-same', purpose: 'mailingSame', question: 'Is the mailing address the same as above?', required: true },
    { pattern: /^chkBxSexOrig(Male|Female)$/, groupKey: 'ihss:birth-sex', purpose: 'birthSex', question: 'What sex was listed on the original birth certificate?', required: false },
    { pattern: /^chkBxVeteran(Yes|No)$/, groupKey: 'ihss:veteran', purpose: 'veteran', question: 'Are you a veteran?', required: false },
    { pattern: /^chkBxSSI(Yes|No)$/, groupKey: 'ihss:ssi', purpose: 'receivesSsi', question: 'Do you receive SSI/SSP benefits?', required: false },
    { pattern: /^chkBxAssistance(Yes|No)$/, groupKey: 'ihss:home-assistance', purpose: 'homeAssistanceAvailable', question: 'Do you have anyone available to provide assistance at home?', required: false },
    { pattern: /^chkBxLiveAlone(Yes|No)$/, groupKey: 'ihss:lives-alone', purpose: 'livesAlone', question: 'Do you live alone?', required: false },
    { pattern: /^chkBxRcvIHSSServices(Yes|No)$/, groupKey: 'ihss:household-receives-services', purpose: 'ihssHouseholdReceivesServices', question: 'Is anyone in your home currently receiving IHSS services?', required: false },
    { className: 'chkBxLivingArrangement', groupKey: 'ihss:living-arrangement', purpose: 'livingArrangement', question: 'Check your type of living arrangement', required: true },
    { pattern: /^chkBxPastIHSS(Yes|No)$/, groupKey: 'ihss:past-services', purpose: 'pastIhss', question: 'Have you received IHSS in the past?', required: false },
    { pattern: /^chkBxBlind(Yes|No)$/, groupKey: 'ihss:blind', purpose: 'blind', question: 'Applicant is blind', required: true },
    { pattern: /^chkBxVis(?:Impaired)?(Yes|No)$/, groupKey: 'ihss:visually-impaired', purpose: 'visuallyImpaired', question: 'Applicant is visually impaired', required: true },
  ]);

  const IHSS_HEALTH_HISTORY_PURPOSES = Object.freeze({
    '95': 'ihssDailyLivingLimitations',
    '96': 'ihssHospiceCare',
    '97': 'ihssTerminalIllness',
    '98': 'ihssOrganTransplant',
    '100': 'ihssSupplementalOxygen',
    '101': 'ihssCancerTreatment',
  });

  const IHSS_SERVICE_PURPOSES = Object.freeze({
    '80': 'ihssDomesticServices',
    '81': 'ihssPersonalCare',
    '82': 'ihssTransportation',
    '83': 'ihssParamedicalCare',
  });

  // First match wins. The order is a PII-scoping safety rule: household and
  // conditional-entity fields resolve before the exact applicant ids, so
  // applicant name, birthdate, and SSN are never copied into another person's row.
  const IHSS_RULES = Object.freeze([
    exactIdRule(IHSS_HOUSEHOLD_FIELDS),
    idPatternRule(IHSS_REPEATED_HOUSEHOLD_ID, { unmapped: true, required: true }),
    idSetRule(IHSS_UNMAPPED_REQUIRED_IDS, { unmapped: true, required: true }),
    exactIdRule(IHSS_UNMAPPED_OPTIONAL_FIELDS),
    ...IHSS_UNMAPPED_CHOICES.map((choice) => choiceRule({ ...choice, unmapped: true })),
    exactIdRule(IHSS_APPLICANT_FIELDS),
    ...IHSS_APPLICANT_CHOICES.map(choiceRule),
    checkboxValueRule('chkBxHealthHistory', IHSS_HEALTH_HISTORY_PURPOSES),
    checkboxValueRule('chkBxIHSSService', IHSS_SERVICE_PURPOSES),
    checkboxValueRule('chkBxOther', { '84': 'ihssOtherServices' }),
  ]);

  function ihssPolicy(field) {
    const scoped = {
      id: String(field.id || ''),
      value: String(field.value || ''),
      className: String(field.className || ''),
    };
    for (const rule of IHSS_RULES) {
      const policy = rule(scoped);
      if (policy) return policy;
    }
    return null;
  }

  function wicPolicy(field) {
    const id = String(field.id || '');
    const applicantCategory = {
      decisionGroupKey: 'wic:applicant-category',
      decisionGroupQuestion: 'Please select all that apply',
    };
    const appointmentMethods = {
      decisionGroupKey: 'wic:appointment-methods',
      decisionGroupQuestion: 'Which WIC appointment methods should be authorized?',
    };
    const policies = {
      'edit-name': { purpose: 'fullName' },
      'edit-date-of-birth': { purpose: 'dateOfBirth', required: true },
      'edit-home-address': { purpose: 'addressLine1', required: true },
      'edit-mailing-address-if-different-from-home-address-': { purpose: 'alternateMailingAddress' },
      'edit-mobile': { purpose: 'phone', required: true },
      'edit-email': { purpose: 'email' },
      'edit-what-is-your-preferred-language': { purpose: 'primaryLanguage' },
      'edit-if-yes': { purpose: 'mediCalCaseNumber', sensitive: true },
      'edit-please-select-all-that-apply-pregnant': { purpose: 'pregnant', ...applicantCategory },
      'edit-please-select-all-that-apply-post-partum': { purpose: 'wicPostpartum', ...applicantCategory },
      'edit-please-select-all-that-apply-infant-breastfeeding': { purpose: 'wicBreastfeedingInfant', ...applicantCategory },
      'edit-please-select-all-that-apply-infant-formula': { purpose: 'wicFormulaInfant', ...applicantCategory },
      'edit-please-select-all-that-apply-childrentoddler-0-5': { purpose: 'wicChildUnderFive', ...applicantCategory },
      'edit-i-authorize-my-wic-appointments-select-all-that-apply-in-person': { purpose: 'wicAppointmentInPerson', ...appointmentMethods },
      'edit-i-authorize-my-wic-appointments-select-all-that-apply-virtual-phone': { purpose: 'wicAppointmentPhone', ...appointmentMethods },
      'edit-i-authorize-my-wic-appointments-select-all-that-apply-telehealth-video': { purpose: 'wicAppointmentVideo', ...appointmentMethods },
      'edit-please-choose-the-wic-clinic-closest-to-you': { purpose: 'wicClinic' },
    };
    if (policies[id]) return policies[id];
    if (/^edit-can-you-receive-text-messages-(?:yes|no)$/.test(id)) {
      return exclusiveGroup('wic:receive-texts', 'canReceiveTexts', 'Can you receive text messages?', true, id.endsWith('-yes') ? 'Yes' : 'No');
    }
    if (/^edit-do-you-have-medical-(?:yes|no|in-progress)$/.test(id)) {
      const optionValue = id.endsWith('-in-progress') ? 'In progress' : id.endsWith('-yes') ? 'Yes' : 'No';
      return exclusiveGroup('wic:medical', 'mediCalCoverage', 'Do you have Medi-Cal?', true, optionValue);
    }
    return null;
  }

  function fieldPolicy(hostname, pathname, field = {}) {
    if (hostMatches(hostname, 'riversideihss.org') && pathMatchesPrefix(pathname, '/IntakeApp')) {
      return ihssPolicy(field);
    }
    if (hostMatches(hostname, 'ruhealth.org') && pathMatchesPrefix(pathname, '/appointments/apply-4-wic-form')) {
      return wicPolicy(field);
    }
    return null;
  }

  const api = { fieldPolicy, hostMatches, pathMatchesPrefix };
  root.NavaSiteAdapters = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
