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

  function ihssPolicy(field) {
    const id = String(field.id || '');
    const value = String(field.value || '');
    const className = String(field.className || '');

    // Household values are deliberately scoped to the first household-member
    // entity. They must never inherit applicant-level name, birthdate, or SSN.
    const household = {
      relationshipDrpDwn: { purpose: 'ihssHouseholdRelationship', required: true },
      nameHouseholdTxt: { purpose: 'ihssHouseholdMemberName', required: true },
      birthDateHouseholdTxt: { purpose: 'ihssHouseholdMemberDateOfBirth', required: true },
      ssnHouseholdTxt: { purpose: 'ihssHouseholdMemberSsn', required: true, sensitive: true },
    };
    if (household[id]) return household[id];
    if (/^(?:relationshipDrpDwn|nameHouseholdTxt|birthDateHouseholdTxt|ssnHouseholdTxt)[-_:]?\d+$/.test(id)) {
      return { unmapped: true, required: true };
    }

    // Visible conditional entity fields must surface as gaps instead of
    // inheriting applicant values or disappearing from the review. Hidden
    // controls are omitted by the scanner and will be reconsidered on rescan.
    if (/^(?:repFirstNameTxt|repLastNameTxt|repPhoneTxt|ticketId2Txt|relToApplicantDrpDwn|hppDrpDwn|otherHPPTxt|caDrpDwn|otherCATxt|otherRelTypeTxt)$/.test(id)
      || /^(?:veteranNameTxt|veteranClaimNumberTxt)$/.test(id)
      || /^(?:nameOfFacilityTxt|facilityStreetTxt|facilityCityTxt|facilityStateTxt|facilityZipCodeTxt|expectedDateOfDischargeTxt)$/.test(id)
      || /^(?:pastIHSSDateTxt|pastIHSSCountyTxt|monthlyHoursTxt|nameUsedTxt)$/.test(id)
      || id === 'otherServiceRequestedTxt') {
      return { unmapped: true, required: true };
    }
    if (id === 'repEmailTxt') return { unmapped: true, required: false };

    if (/^chkBxApplicantAgree(?:Yes|No)$/.test(id)) {
      return { ...exclusiveGroup(
        'ihss:applicant-agrees',
        '',
        'Does the applicant agree to apply for IHSS services?',
        true,
        id.endsWith('Yes') ? 'Yes' : 'No',
      ), unmapped: true };
    }
    if (/^chkBxVeteranRel(?:Yes|No)$/.test(id)) {
      return { ...exclusiveGroup(
        'ihss:veteran-relative',
        '',
        'Is the applicant a relative of a veteran?',
        true,
        id.endsWith('Yes') ? 'Yes' : 'No',
      ), unmapped: true };
    }

    const exact = {
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
    if (exact[id]) return exact[id];

    if (/^chkBxApplyYourself(?:Yes|No)$/.test(id)) {
      return exclusiveGroup('ihss:applying-for-self', 'ihssApplyingForSelf', 'Are you applying to receive IHSS for yourself?', true, id.endsWith('Yes') ? 'Yes' : 'No');
    }
    if (/^chkBxSex(?:Male|Female)$/.test(id)) {
      return exclusiveGroup('ihss:sex', 'gender', 'Sex', true, id.endsWith('Female') ? 'Female' : 'Male');
    }
    if (/^chkBxAdoptedChild(?:Yes|No)$/.test(id)) {
      return exclusiveGroup('ihss:adopted-child', 'ihssAdoptedMinorChild', 'Is the application for a minor adopted child?', true, id.endsWith('Yes') ? 'Yes' : 'No');
    }
    if (/^chkBxMailAddress(?:Yes|No)$/.test(id)) {
      return exclusiveGroup('ihss:mailing-same', 'mailingSame', 'Is the mailing address the same as above?', true, id.endsWith('Yes') ? 'Yes' : 'No');
    }
    if (/^chkBxSexOrig(?:Male|Female)$/.test(id)) {
      return exclusiveGroup('ihss:birth-sex', 'birthSex', 'What sex was listed on the original birth certificate?', false, id.endsWith('Female') ? 'Female' : 'Male');
    }
    if (/^chkBxVeteran(?:Yes|No)$/.test(id)) {
      return exclusiveGroup('ihss:veteran', 'veteran', 'Are you a veteran?', false, id.endsWith('Yes') ? 'Yes' : 'No');
    }
    if (/^chkBxSSI(?:Yes|No)$/.test(id)) {
      return exclusiveGroup('ihss:ssi', 'receivesSsi', 'Do you receive SSI/SSP benefits?', false, id.endsWith('Yes') ? 'Yes' : 'No');
    }
    if (/^chkBxAssistance(?:Yes|No)$/.test(id)) {
      return exclusiveGroup('ihss:home-assistance', 'homeAssistanceAvailable', 'Do you have anyone available to provide assistance at home?', false, id.endsWith('Yes') ? 'Yes' : 'No');
    }
    if (/^chkBxLiveAlone(?:Yes|No)$/.test(id)) {
      return exclusiveGroup('ihss:lives-alone', 'livesAlone', 'Do you live alone?', false, id.endsWith('Yes') ? 'Yes' : 'No');
    }
    if (/^chkBxRcvIHSSServices(?:Yes|No)$/.test(id)) {
      return exclusiveGroup(
        'ihss:household-receives-services',
        'ihssHouseholdReceivesServices',
        'Is anyone in your home currently receiving IHSS services?',
        false,
        id.endsWith('Yes') ? 'Yes' : 'No',
      );
    }
    if (className.split(/\s+/).includes('chkBxLivingArrangement')) {
      return exclusiveGroup('ihss:living-arrangement', 'livingArrangement', 'Check your type of living arrangement', true, value);
    }
    if (/^chkBxPastIHSS(?:Yes|No)$/.test(id)) {
      return exclusiveGroup('ihss:past-services', 'pastIhss', 'Have you received IHSS in the past?', false, id.endsWith('Yes') ? 'Yes' : 'No');
    }
    if (/^chkBxBlind(?:Yes|No)$/.test(id)) {
      return exclusiveGroup('ihss:blind', 'blind', 'Applicant is blind', true, id.endsWith('Yes') ? 'Yes' : 'No');
    }
    if (/^chkBxVis(?:Impaired)?(?:Yes|No)$/.test(id)) {
      return exclusiveGroup('ihss:visually-impaired', 'visuallyImpaired', 'Applicant is visually impaired', true, id.endsWith('Yes') ? 'Yes' : 'No');
    }

    if (id === 'chkBxHealthHistory') {
      const purposes = {
        '95': 'ihssDailyLivingLimitations',
        '96': 'ihssHospiceCare',
        '97': 'ihssTerminalIllness',
        '98': 'ihssOrganTransplant',
        '100': 'ihssSupplementalOxygen',
        '101': 'ihssCancerTreatment',
      };
      return purposes[value]
        ? { purpose: purposes[value], required: true, groupKey: '', exclusive: false }
        : null;
    }
    if (id === 'chkBxIHSSService') {
      const purposes = {
        '80': 'ihssDomesticServices',
        '81': 'ihssPersonalCare',
        '82': 'ihssTransportation',
        '83': 'ihssParamedicalCare',
      };
      return purposes[value]
        ? { purpose: purposes[value], required: true, groupKey: '', exclusive: false }
        : null;
    }
    if (id === 'chkBxOther' && value === '84') {
      return { purpose: 'ihssOtherServices', required: true, groupKey: '', exclusive: false };
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
