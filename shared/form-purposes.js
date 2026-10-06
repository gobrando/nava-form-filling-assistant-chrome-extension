// Canonical purpose vocabulary (labels; sensitive, never-derive and yes/no purpose sets) and the ordered rules that classify a form field into one purpose.
(function installFormPurposes(root) {
  'use strict';

  const LABELS = {
    firstName: 'First name', middleName: 'Middle name', lastName: 'Last name',
    fullName: 'Full name', dateOfBirth: 'Date of birth', ssn: 'Social Security Number',
    email: 'Email', phone: 'Phone', addressLine1: 'Street address', addressLine2: 'Apartment or unit',
    city: 'City', state: 'State', county: 'County', postalCode: 'ZIP code', country: 'Country',
    gender: 'Gender', ethnicity: 'Ethnicity', primaryLanguage: 'Primary language',
    maritalStatus: 'Marital status', specialNeeds: 'Special needs', farmWorker: 'Farm worker',
    pregnant: 'Pregnancy', preferredContact: 'Preferred contact method', housingStatus: 'Housing status',
    householdSize: 'Household size', immigrationStatus: 'Immigration status', income: 'Income',
    childcare: 'Childcare', unemployment: 'Unemployment benefits', mailingDifferent: 'Mailing address',
    mailingSame: 'Mailing address is the same', alternateMailingAddress: 'Alternate mailing address',
    mailingAddressLine1: 'Mailing street address', mailingAddressLine2: 'Mailing apartment or unit',
    mailingCity: 'Mailing city', mailingState: 'Mailing state', mailingPostalCode: 'Mailing ZIP code',
    suffix: 'Name suffix', genderIdentity: 'Gender identity', birthSex: 'Sex listed at birth',
    sexualOrientation: 'Sexual orientation', veteran: 'Veteran status', receivesSsi: 'SSI/SSP benefits',
    homeAssistanceAvailable: 'Home assistance availability', livesAlone: 'Lives alone',
    livingArrangement: 'Living arrangement', blind: 'Blind', visuallyImpaired: 'Visually impaired',
    ihssApplyingForSelf: 'Applying for IHSS for self', ihssAdoptedMinorChild: 'Minor adopted child',
    ihssHouseholdReceivesServices: 'Someone in the home receives IHSS services',
    ihssHouseholdRelationship: 'Household member relationship',
    ihssHouseholdMemberName: 'Household member name',
    ihssHouseholdMemberDateOfBirth: 'Household member date of birth',
    ihssHouseholdMemberSsn: 'Household member Social Security Number',
    ihssHealthHistory: 'Health history', ihssDailyLivingLimitations: 'Daily-living limitations',
    ihssHospiceCare: 'Hospice care', ihssTerminalIllness: 'Terminal illness',
    ihssOrganTransplant: 'Recent or pending organ transplant', ihssSupplementalOxygen: 'Supplemental oxygen',
    ihssCancerTreatment: 'Cancer treatment', ihssDomesticServices: 'IHSS domestic services',
    ihssPersonalCare: 'IHSS personal care', ihssTransportation: 'IHSS transportation',
    ihssParamedicalCare: 'IHSS paramedical care', ihssOtherServices: 'Other IHSS services',
    pastIhss: 'Past IHSS services', canReceiveTexts: 'Can receive text messages',
    mediCalCoverage: 'Medi-Cal coverage', mediCalCaseNumber: 'Medi-Cal case number',
    wicPostpartum: 'Post-partum', wicBreastfeedingInfant: 'Breastfeeding infant',
    wicFormulaInfant: 'Formula-fed infant', wicChildUnderFive: 'Child under five',
    wicAppointmentInPerson: 'In-person WIC appointments', wicAppointmentPhone: 'Phone WIC appointments',
    wicAppointmentVideo: 'Video WIC appointments', wicClinic: 'WIC clinic',
    recordId: 'Record ID', businessName: 'Business legal name', dba: 'Doing business as',
    ein: 'Employer Identification Number', businessType: 'Business type',
    businessAddressLine1: 'Business street address', businessAddressLine2: 'Business suite or unit',
    businessCity: 'Business city', businessState: 'Business state', businessPostalCode: 'Business ZIP code',
    businessPhone: 'Business phone', businessEmail: 'Business email',
    incorporationDate: 'Formation date', stateOfFormation: 'State of formation',
    applyCalFresh: 'Apply for CalFresh', applyMediCal: 'Apply for Medi-Cal', applyCalWORKs: 'Apply for CalWORKs',
  };

  const DO_NOT_DERIVE = new Set([
    'ssn',
    'ihssHouseholdMemberSsn',
    'specialNeeds',
    'farmWorker',
    'pregnant',
    'housingStatus',
    'preferredContact',
    'householdSize',
    'immigrationStatus',
    'income',
    'childcare',
    'unemployment',
    'ein',
    'wicPostpartum',
    'wicBreastfeedingInfant',
    'wicFormulaInfant',
    'wicChildUnderFive',
    'wicAppointmentInPerson',
    'wicAppointmentPhone',
    'wicAppointmentVideo',
  ]);

  const SENSITIVE_PURPOSES = new Set(['ssn', 'ihssHouseholdMemberSsn', 'ein']);

  // Purposes whose record value is written as a yes/no answer.
  const YES_NO_PURPOSES = [
    'specialNeeds', 'farmWorker', 'pregnant', 'childcare', 'unemployment', 'mailingDifferent', 'mailingSame',
    'applyCalFresh', 'applyMediCal', 'applyCalWORKs', 'veteran', 'receivesSsi', 'homeAssistanceAvailable',
    'livesAlone', 'blind', 'visuallyImpaired', 'ihssApplyingForSelf', 'ihssAdoptedMinorChild', 'ihssHouseholdReceivesServices',
    'ihssDailyLivingLimitations', 'ihssHospiceCare', 'ihssTerminalIllness', 'ihssOrganTransplant',
    'ihssSupplementalOxygen', 'ihssCancerTreatment', 'ihssDomesticServices', 'ihssPersonalCare',
    'ihssTransportation', 'ihssParamedicalCare', 'ihssOtherServices', 'pastIhss', 'canReceiveTexts',
    'wicPostpartum', 'wicBreastfeedingInfant', 'wicFormulaInfant', 'wicChildUnderFive',
    'wicAppointmentInPerson', 'wicAppointmentPhone', 'wicAppointmentVideo',
  ];

  function normalize(value) {
    return String(value ?? '')
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  }

  function compact(value) {
    return normalize(value).replace(/\s+/g, '');
  }

  // ---- Field classification: which canonical purpose a form field asks for ----

  // Ordered, first match wins, so order is behavior: business address before address, address line 2 before
  // line 1, email before phone, gender identity and birth sex before gender. `phrases` match anywhere in the
  // normalized field signal, `words` match whole tokens, `exact` matches the whole signal; `unless` phrases veto
  // the rule and `types` limits it to those field types (a field with no type always qualifies).
  const FIELD_PURPOSE_RULES = [
    { purpose: 'ein', exact: ['ein'], phrases: ['employer identification', 'federal tax id', 'federal tax identification', 'business tax id'] },
    { purpose: 'ssn', exact: ['ssn'], phrases: ['social security', ' ssn', 'ssn '] },
    { purpose: 'applyCalFresh', phrases: ['calfresh', 'cal fresh'] },
    { purpose: 'applyMediCal', phrases: ['medi cal', 'medi-cal', 'medical benefits'] },
    { purpose: 'applyCalWORKs', phrases: ['calworks', 'cal works'] },
    { purpose: 'dba', phrases: ['doing business as', ' dba', 'dba '] },
    { purpose: 'businessName', phrases: ['business legal name', 'legal business name', 'company legal name', 'business name', 'company name'] },
    { purpose: 'businessType', phrases: ['entity type', 'business type', 'legal structure'] },
    { purpose: 'stateOfFormation', phrases: ['state of formation', 'state of incorporation', 'formation state'] },
    { purpose: 'incorporationDate', phrases: ['date of formation', 'formation date', 'incorporation date'] },
    { purpose: 'businessEmail', phrases: ['business email', 'company email'] },
    { purpose: 'businessPhone', phrases: ['business phone', 'company phone'] },
    { purpose: 'businessAddressLine2', phrases: ['business address line 2', 'business apartment', 'business suite', 'company suite'] },
    { purpose: 'businessAddressLine1', phrases: ['business address', 'company address', 'business street'] },
    { purpose: 'businessCity', phrases: ['business city', 'company city'] },
    { purpose: 'businessState', phrases: ['business state', 'company state'] },
    { purpose: 'businessPostalCode', phrases: ['business zip', 'business postal', 'company zip'] },
    { purpose: 'dateOfBirth', phrases: ['date of birth', 'birth date', 'birthdate', ' dob ', 'bday'] },
    { purpose: 'firstName', phrases: ['first name', 'given name', 'given-name', 'firstname', 'namefirst'] },
    { purpose: 'middleName', phrases: ['middle name', 'additional name', 'additional-name', 'middlename', 'namemiddle'] },
    { purpose: 'lastName', phrases: ['last name', 'family name', 'family-name', 'surname', 'lastname', 'namelast'] },
    { purpose: 'suffix', phrases: ['name suffix', 'suffix'] },
    { purpose: 'fullName', phrases: ['full name', 'your name'], unless: ['organization'] },
    { purpose: 'email', phrases: ['email'] },
    { purpose: 'phone', phrases: ['phone', 'telephone', 'mobile', 'tel '], types: ['text', 'tel', 'phone'] },
    { purpose: 'housingStatus', phrases: ['experiencing homelessness', 'homeless', 'housing status', 'stable housing'] },
    { purpose: 'preferredContact', phrases: ['preferred contact', 'contact preference', 'how should we contact', 'best way to contact'] },
    { purpose: 'immigrationStatus', phrases: ['immigration status', 'citizenship status'] },
    { purpose: 'householdSize', phrases: ['household size', 'people in household', 'other people living', 'lives alone'] },
    { purpose: 'income', phrases: ['monthly household income', 'monthly income', 'gross income', 'income from a job'] },
    { purpose: 'childcare', phrases: ['paying for childcare', 'child care', 'childcare'] },
    { purpose: 'unemployment', phrases: ['unemployment benefits', 'unemployment'] },
    { purpose: 'alternateMailingAddress', phrases: ['mailing address if different', 'alternate mailing address'] },
    { purpose: 'mailingSame', phrases: ['mailing address is the same', 'mailing address the same', 'mailing address same', 'same as home',
      'same as your home', 'same as residential', 'same as your residential', 'mailing same'] },
    { purpose: 'mailingDifferent', phrases: ['mail at a different address', 'mailing address is different', 'mailing address different', 'different mailing address'] },
    { purpose: 'addressLine2', phrases: ['apartment', 'apt ', 'unit ', 'suite', 'address line 2', 'address-line2'] },
    { purpose: 'addressLine1', phrases: ['street address', 'home address', 'residential address', 'address line 1', 'address-line1', 'street'] },
    { purpose: 'postalCode', phrases: ['postal code', 'zip code', 'zipcode', 'postal-code', ' zip '] },
    { purpose: 'city', words: ['city'], phrases: ['address-level2'] },
    { purpose: 'county', words: ['county'] },
    { purpose: 'state', words: ['state', 'province'], phrases: ['address-level1'] },
    { purpose: 'country', words: ['country'], phrases: ['country-name'] },
    { purpose: 'primaryLanguage', phrases: ['primary language', 'preferred language', 'language'] },
    { purpose: 'ethnicity', phrases: ['ethnicity', 'ethnic origin', 'hispanic'] },
    { purpose: 'genderIdentity', phrases: ['gender identity'] },
    { purpose: 'birthSex', phrases: ['sex assigned at birth', 'sex listed at birth', 'original birth certificate'] },
    { purpose: 'sexualOrientation', phrases: ['sexual orientation'] },
    { purpose: 'gender', phrases: ['gender'], words: ['sex'] },
    { purpose: 'maritalStatus', phrases: ['marital status', 'married'] },
    { purpose: 'specialNeeds', phrases: ['special needs', 'disability', 'disabled'] },
    { purpose: 'farmWorker', phrases: ['farm worker', 'farmworker', 'migrant worker'] },
    { purpose: 'pregnant', phrases: ['pregnant', 'pregnancy'] },
    { purpose: 'recordId', phrases: ['record id', 'client id', 'participant id', 'apricot id'] },
  ].map((rule) => ({ exact: [], phrases: [], words: [], unless: [], types: null, ...rule }));

  // Everything a field says about itself, as one normalized string.
  function fieldSignal(field) {
    return normalize([field.autocomplete, field.question, field.label, field.name, field.id, field.placeholder].filter(Boolean).join(' '));
  }

  function ruleMatches(rule, signal, tokens, fieldType) {
    if (rule.types && fieldType && !rule.types.includes(fieldType)) return false;
    if (rule.unless.some((phrase) => signal.includes(phrase))) return false;
    return rule.exact.includes(signal)
      || rule.phrases.some((phrase) => signal.includes(phrase))
      || rule.words.some((word) => tokens.has(word));
  }

  function classifyField(field) {
    if (field?.unmapped === true) return null;
    if (field?.purpose && Object.prototype.hasOwnProperty.call(LABELS, field.purpose)) return field.purpose;
    const signal = fieldSignal(field);
    const tokens = new Set(signal.split(' ').filter(Boolean));
    const rule = FIELD_PURPOSE_RULES.find((candidate) => ruleMatches(candidate, signal, tokens, field.type));
    return rule ? rule.purpose : null;
  }

  const api = {
    DO_NOT_DERIVE,
    LABELS,
    SENSITIVE_PURPOSES,
    YES_NO_PURPOSES,
    classifyField,
    compact,
    normalize,
  };

  root.NavaFormPurposes = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
