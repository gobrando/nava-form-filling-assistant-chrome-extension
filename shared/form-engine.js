// Form engine: canonicalizes a client record, classifies form fields by purpose, formats record values for each
// field, and builds the fill analysis (assignments, gaps, observed values) the side panel and page agent act on.
(function installFormEngine(root) {
  'use strict';

  const STATE_CODES = {
    alabama: 'AL', alaska: 'AK', arizona: 'AZ', arkansas: 'AR', california: 'CA',
    colorado: 'CO', connecticut: 'CT', delaware: 'DE', florida: 'FL', georgia: 'GA',
    hawaii: 'HI', idaho: 'ID', illinois: 'IL', indiana: 'IN', iowa: 'IA', kansas: 'KS',
    kentucky: 'KY', louisiana: 'LA', maine: 'ME', maryland: 'MD', massachusetts: 'MA',
    michigan: 'MI', minnesota: 'MN', mississippi: 'MS', missouri: 'MO', montana: 'MT',
    nebraska: 'NE', nevada: 'NV', 'new hampshire': 'NH', 'new jersey': 'NJ',
    'new mexico': 'NM', 'new york': 'NY', 'north carolina': 'NC', 'north dakota': 'ND',
    ohio: 'OH', oklahoma: 'OK', oregon: 'OR', pennsylvania: 'PA', 'rhode island': 'RI',
    'south carolina': 'SC', 'south dakota': 'SD', tennessee: 'TN', texas: 'TX', utah: 'UT',
    vermont: 'VT', virginia: 'VA', washington: 'WA', 'west virginia': 'WV', wisconsin: 'WI',
    wyoming: 'WY', 'district of columbia': 'DC',
  };

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

  function hasValue(value) {
    return value !== undefined && value !== null && value !== '';
  }

  function getPath(object, path) {
    return path.split('.').reduce((value, part) => value?.[part], object);
  }

  function firstValue(object, paths) {
    for (const path of paths) {
      const value = getPath(object, path);
      if (hasValue(value)) return value;
    }
    return undefined;
  }

  // ---- Participant record: one canonical value per purpose from the many client-record shapes ----

  // Placeholder for a value computed by a named helper below; it keeps that value's place in the key order.
  const DERIVED = [];

  // Canonical key -> record paths, first non-empty path wins. Key order is the order of canonicalizeParticipant().values.
  const PARTICIPANT_SOURCE_PATHS = {
    recordId: ['record_id', 'recordId', 'id'],
    firstName: ['firstName', 'first_name', 'participant.name.first', 'name.first'],
    middleName: ['middleName', 'middle_name', 'participant.name.middle', 'name.middle'],
    lastName: ['lastName', 'last_name', 'participant.name.last', 'name.last'],
    suffix: ['suffix', 'nameSuffix', 'participant.name.suffix', 'name.suffix'],
    fullName: ['fullName', 'name'],
    dateOfBirth: ['dateOfBirth', 'date_of_birth', 'participant.date_of_birth', 'dob'],
    ssn: ['ssn', 'socialSecurityNumber', 'participant.ssn'],
    email: ['email', 'contact_information.email', 'contact.email'],
    phone: ['phone', 'contact_information.phones.cell', 'contact_information.phones.main', 'contact_information.phones.home', 'contact.phone'],
    addressLine1: ['addressLine1', 'address.street', 'address.residential.street', 'residentialAddress.street'],
    addressLine2: ['addressLine2', 'address.unit', 'address.residential.unit', 'residentialAddress.unit'],
    city: ['city', 'address.city', 'address.residential.city', 'residentialAddress.city'],
    state: ['state', 'address.state', 'address.residential.state', 'residentialAddress.state'],
    county: ['county', 'address.county', 'address.residential.county', 'residentialAddress.county'],
    postalCode: ['postalCode', 'zip', 'address.zip', 'address.residential.zip', 'residentialAddress.zip'],
    country: ['country', 'address.country', 'address.residential.country', 'residentialAddress.country'],
    gender: ['gender', 'sex', 'participant.gender'],
    genderIdentity: ['genderIdentity', 'gender_identity', 'participant.gender_identity', 'programData.ihss.genderIdentity', 'ihss.genderIdentity'],
    birthSex: ['birthSex', 'birth_sex', 'sexAtBirth', 'participant.birth_sex', 'programData.ihss.birthSex', 'ihss.birthSex'],
    sexualOrientation: ['sexualOrientation', 'sexual_orientation', 'participant.sexual_orientation', 'programData.ihss.sexualOrientation', 'ihss.sexualOrientation'],
    ethnicity: ['ethnicity', 'participant.ethnicity'],
    primaryLanguage: ['primaryLanguage', 'primary_language', 'participant.primary_language'],
    maritalStatus: ['maritalStatus', 'marital_status', 'participant.marital_status'],
    specialNeeds: ['specialNeeds', 'special_needs', 'participant.special_needs'],
    farmWorker: ['farmWorker', 'farm_worker', 'participant.farm_worker'],
    pregnant: ['pregnant', 'pregnancyStatus', 'participant.pregnant'],
    preferredContact: ['preferredContact', 'contact_information.preferred_method', 'contact.preferredMethod'],
    housingStatus: ['housingStatus', 'housing_status', 'participant.housing_status'],
    householdSize: ['householdSize', 'household_size'],
    immigrationStatus: ['immigrationStatus', 'immigration_status'],
    income: ['income', 'monthlyIncome', 'monthly_income'],
    childcare: ['childcare', 'paysForChildcare', 'pays_for_childcare'],
    unemployment: ['unemployment', 'appliedForUnemployment', 'applied_for_unemployment'],
    applyCalFresh: ['applicationSelection.calfresh'], applyMediCal: ['applicationSelection.medical'], applyCalWORKs: ['applicationSelection.calworks'],
    mailingDifferent: DERIVED, mailingSame: DERIVED, alternateMailingAddress: DERIVED, mailingAddressLine1: DERIVED,
    mailingAddressLine2: DERIVED, mailingCity: DERIVED, mailingState: DERIVED, mailingPostalCode: DERIVED,
    veteran: ['veteran', 'veteranStatus', 'programData.ihss.veteran', 'ihss.veteran'],
    receivesSsi: ['receivesSsi', 'receivesSSI', 'programData.ihss.receivesSsi', 'ihss.receivesSsi'],
    homeAssistanceAvailable: ['homeAssistanceAvailable', 'programData.ihss.homeAssistanceAvailable', 'ihss.homeAssistanceAvailable'],
    livesAlone: ['livesAlone', 'programData.ihss.livesAlone', 'ihss.livesAlone'],
    livingArrangement: ['livingArrangement', 'programData.ihss.livingArrangement', 'ihss.livingArrangement'],
    blind: ['blind', 'programData.ihss.blind', 'ihss.blind'],
    visuallyImpaired: ['visuallyImpaired', 'programData.ihss.visuallyImpaired', 'ihss.visuallyImpaired'],
    ihssApplyingForSelf: ['ihssApplyingForSelf', 'programData.ihss.applyingForSelf', 'ihss.applyingForSelf'],
    ihssAdoptedMinorChild: ['ihssAdoptedMinorChild', 'programData.ihss.adoptedMinorChild', 'ihss.adoptedMinorChild'],
    ihssHouseholdReceivesServices: ['ihssHouseholdReceivesServices', 'programData.ihss.householdReceivesServices', 'ihss.householdReceivesServices'],
    ihssHouseholdRelationship: ['ihssHouseholdRelationship', 'programData.ihss.householdMembers.0.relationship', 'ihss.householdMembers.0.relationship'],
    ihssHouseholdMemberName: ['ihssHouseholdMemberName', 'programData.ihss.householdMembers.0.name', 'ihss.householdMembers.0.name'],
    ihssHouseholdMemberDateOfBirth: ['ihssHouseholdMemberDateOfBirth', 'programData.ihss.householdMembers.0.dateOfBirth', 'ihss.householdMembers.0.dateOfBirth'],
    ihssHouseholdMemberSsn: ['ihssHouseholdMemberSsn', 'programData.ihss.householdMembers.0.ssn', 'ihss.householdMembers.0.ssn'],
    ihssHealthHistory: ['ihssHealthHistory', 'programData.ihss.healthHistory', 'ihss.healthHistory'],
    ihssDailyLivingLimitations: ['ihssDailyLivingLimitations', 'programData.ihss.dailyLivingLimitations', 'ihss.dailyLivingLimitations'],
    ihssHospiceCare: ['ihssHospiceCare', 'programData.ihss.hospiceCare', 'ihss.hospiceCare'],
    ihssTerminalIllness: ['ihssTerminalIllness', 'programData.ihss.terminalIllness', 'ihss.terminalIllness'],
    ihssOrganTransplant: ['ihssOrganTransplant', 'programData.ihss.organTransplant', 'ihss.organTransplant'],
    ihssSupplementalOxygen: ['ihssSupplementalOxygen', 'programData.ihss.supplementalOxygen', 'ihss.supplementalOxygen'],
    ihssCancerTreatment: ['ihssCancerTreatment', 'programData.ihss.cancerTreatment', 'ihss.cancerTreatment'],
    ihssDomesticServices: ['ihssDomesticServices', 'programData.ihss.domesticServices', 'ihss.domesticServices'],
    ihssPersonalCare: ['ihssPersonalCare', 'programData.ihss.personalCare', 'ihss.personalCare'],
    ihssTransportation: ['ihssTransportation', 'programData.ihss.transportation', 'ihss.transportation'],
    ihssParamedicalCare: ['ihssParamedicalCare', 'programData.ihss.paramedicalCare', 'ihss.paramedicalCare'],
    ihssOtherServices: ['ihssOtherServices', 'programData.ihss.otherServices', 'ihss.otherServices'],
    pastIhss: ['pastIhss', 'programData.ihss.pastIhss', 'ihss.pastIhss'],
    canReceiveTexts: ['canReceiveTexts', 'programData.wic.canReceiveTexts', 'wic.canReceiveTexts'],
    mediCalCoverage: ['mediCalCoverage', 'programData.wic.mediCalCoverage', 'wic.mediCalCoverage'],
    mediCalCaseNumber: ['mediCalCaseNumber', 'programData.wic.mediCalCaseNumber', 'wic.mediCalCaseNumber'],
    wicPostpartum: ['wicPostpartum', 'programData.wic.postpartum', 'wic.postpartum'],
    wicBreastfeedingInfant: ['wicBreastfeedingInfant', 'programData.wic.breastfeedingInfant', 'wic.breastfeedingInfant'],
    wicFormulaInfant: ['wicFormulaInfant', 'programData.wic.formulaInfant', 'wic.formulaInfant'],
    wicChildUnderFive: ['wicChildUnderFive', 'programData.wic.childUnderFive', 'wic.childUnderFive'],
    wicAppointmentInPerson: ['wicAppointmentInPerson', 'programData.wic.appointmentInPerson', 'wic.appointmentInPerson'],
    wicAppointmentPhone: ['wicAppointmentPhone', 'programData.wic.appointmentPhone', 'wic.appointmentPhone'],
    wicAppointmentVideo: ['wicAppointmentVideo', 'programData.wic.appointmentVideo', 'wic.appointmentVideo'],
    wicClinic: ['wicClinic', 'programData.wic.clinic', 'wic.clinic'],
    businessName: ['businessName', 'business_name', 'business.legalName', 'company.legalName', 'company.name'],
    dba: ['dba', 'doingBusinessAs', 'doing_business_as', 'business.dba', 'company.dba'],
    ein: ['ein', 'employerIdentificationNumber', 'taxId', 'tax_id', 'business.ein'],
    businessType: ['businessType', 'business_type', 'entityType', 'entity_type', 'business.type'],
    businessAddressLine1: ['businessAddressLine1', 'business_address_line_1'],
    businessAddressLine2: ['businessAddressLine2', 'business_address_line_2'],
    businessCity: ['businessCity', 'business_city'],
    businessState: ['businessState', 'business_state'],
    businessPostalCode: ['businessPostalCode', 'business_postal_code', 'businessZip', 'business_zip'],
    businessPhone: ['businessPhone', 'business_phone', 'business.phone', 'company.phone'],
    businessEmail: ['businessEmail', 'business_email', 'business.email', 'company.email'],
    incorporationDate: ['incorporationDate', 'formationDate', 'formation_date', 'business.formationDate'],
    stateOfFormation: ['stateOfFormation', 'state_of_formation', 'business.stateOfFormation'],
  };

  function sameAddress(first, second) {
    if (!first || !second) return undefined;
    const parts = [
      ['street', 'line1', 'addressLine1'],
      ['unit', 'line2', 'addressLine2'],
      ['city'],
      ['state'],
      ['zip', 'postalCode'],
    ];
    const readPart = (address, aliases) => firstValue(address, aliases);
    const firstHasEvidence = parts.some((aliases) => readPart(first, aliases));
    const secondHasEvidence = parts.some((aliases) => readPart(second, aliases));
    if (!firstHasEvidence || !secondHasEvidence) return undefined;
    return parts.every((aliases) => normalize(readPart(first, aliases)) === normalize(readPart(second, aliases)));
  }

  function readSourcePaths(record) {
    return Object.fromEntries(Object.entries(PARTICIPANT_SOURCE_PATHS).map(([key, paths]) => [key, firstValue(record, paths)]));
  }

  // Business address: record-level business keys first, then the business address object.
  function businessAddressValues(values, businessAddress) {
    return {
      businessAddressLine1: values.businessAddressLine1 || firstValue(businessAddress, ['street', 'line1', 'addressLine1']),
      businessAddressLine2: values.businessAddressLine2 || firstValue(businessAddress, ['unit', 'line2', 'addressLine2']),
      businessCity: values.businessCity || businessAddress.city,
      businessState: values.businessState || businessAddress.state,
      businessPostalCode: values.businessPostalCode || firstValue(businessAddress, ['postalCode', 'zip']),
    };
  }

  // Residential address; a business-only record (business name, no person name) falls back to its business address.
  function residentialAddressValues(values, businessAddress) {
    const businessOnly = Boolean(values.businessName && !values.firstName && !values.lastName);
    const businessFallback = {
      addressLine1: values.businessAddressLine1, addressLine2: values.businessAddressLine2, city: values.businessCity,
      state: values.businessState, county: businessAddress.county, postalCode: values.businessPostalCode, country: businessAddress.country,
    };
    return Object.fromEntries(Object.entries(businessFallback)
      .map(([key, fallback]) => [key, values[key] || (businessOnly ? fallback : undefined)]));
  }

  function oneLineAddress(address) {
    return [address.street || address.line1, address.unit || address.line2, address.city, address.state, address.zip || address.postalCode]
      .filter(Boolean).join(', ');
  }

  // Mailing address values, and whether it matches the residential address (undefined unless both are on record).
  function mailingValues(record) {
    const residential = firstValue(record, ['address.residential', 'residentialAddress']) || {};
    const mailing = firstValue(record, ['address.mailing', 'mailingAddress']) || {};
    const addressesMatch = sameAddress(residential, mailing);
    return {
      mailingDifferent: addressesMatch === undefined ? undefined : !addressesMatch,
      mailingSame: addressesMatch,
      alternateMailingAddress: addressesMatch === false ? oneLineAddress(mailing) : undefined,
      mailingAddressLine1: firstValue(mailing, ['street', 'line1', 'addressLine1']),
      mailingAddressLine2: firstValue(mailing, ['unit', 'line2', 'addressLine2']),
      mailingCity: mailing.city,
      mailingState: mailing.state,
      mailingPostalCode: mailing.zip || mailing.postalCode,
    };
  }

  function canonicalizeParticipant(payload) {
    const record = payload || {};
    const values = readSourcePaths(record);
    const composedName = [values.firstName, values.middleName, values.lastName, values.suffix].filter(Boolean).join(' ');
    const businessAddress = firstValue(record, ['businessAddress', 'business.address', 'company.address']) || {};
    values.fullName = composedName || values.fullName;
    Object.assign(values, businessAddressValues(values, businessAddress));
    Object.assign(values, residentialAddressValues(values, businessAddress));
    Object.assign(values, mailingValues(record));
    return {
      values,
      labels: LABELS,
      name: composedName || values.businessName || 'Client',
      recordId: values.recordId,
    };
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

  // ---- Value formatting: the record value rewritten into the shape a field expects ----

  function toDateParts(value) {
    const text = String(value || '').trim();
    const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (iso) return { year: iso[1], month: iso[2], day: iso[3] };
    const us = text.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})$/);
    if (!us) return null;
    const month = Number(us[1]);
    const day = Number(us[2]);
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    return { year: us[3], month: String(month).padStart(2, '0'), day: String(day).padStart(2, '0') };
  }

  function matchingOption(options, value) {
    const wanted = normalize(value);
    if (!wanted) return null;
    const exact = options.find((option) => normalize(option.label) === wanted || normalize(option.value) === wanted);
    if (exact) return exact.value;
    const loose = options.find((option) => {
      const label = normalize(option.label);
      return label.includes(wanted) || wanted.includes(label);
    });
    return loose?.value ?? null;
  }

  function booleanWord(value) {
    if (typeof value === 'boolean') return value ? 'yes' : 'no';
    const word = normalize(value);
    if (['true', 'yes', 'y', '1'].includes(word)) return 'yes';
    if (['false', 'no', 'n', '0'].includes(word)) return 'no';
    return word;
  }

  // A reshaped value; its detail replaces the default only when the value actually changed.
  function reshaped(rawValue, value, detail) {
    return value !== rawValue ? { value, changed: true, detail } : { value, changed: false };
  }

  function formatStateCode(rawValue, field) {
    const stateCode = STATE_CODES[normalize(rawValue)] || String(rawValue).toUpperCase();
    const wantsCode = Number(field.maxLength) === 2 || (field.options || []).some((option) => option.value === stateCode);
    return wantsCode ? reshaped(rawValue, stateCode, `${rawValue} becomes ${stateCode} — the form wants the state code`) : null;
  }

  function dateInFieldFormat(parts, field) {
    if (field.type === 'date') return `${parts.year}-${parts.month}-${parts.day}`;
    if (Number(field.maxLength) === 8) return `${parts.month}${parts.day}${parts.year}`;
    return `${parts.month}/${parts.day}/${parts.year}`;
  }

  function formatDate(rawValue, field) {
    const parts = toDateParts(rawValue);
    if (!parts) return null;
    return reshaped(rawValue, dateInFieldFormat(parts, field), `${rawValue} is written in the form's date format`);
  }

  function wantsUsPhonePattern(field) {
    return String(field.pattern || '').includes('\\(')
      || /^\(#+\)/.test(String(field.placeholder || '').trim());
  }

  function formatPhone(rawValue, field) {
    const digits = String(rawValue).replace(/\D/g, '');
    if (digits.length === 10 && wantsUsPhonePattern(field)) {
      const usPhone = `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
      return reshaped(rawValue, usPhone, 'Phone punctuation is changed to match the form’s required format');
    }
    if (digits && Number(field.maxLength) === 10) {
      return reshaped(rawValue, digits, 'Phone punctuation is removed so the form can add its own format');
    }
    return null;
  }

  function formatSsnDigits(rawValue, field) {
    if (Number(field.maxLength) !== 9) return null;
    const digits = String(rawValue).replace(/\D/g, '');
    if (!digits) return null;
    return reshaped(rawValue, digits, 'Social Security Number punctuation is removed to match the form’s nine-digit field');
  }

  // Street purpose -> [its unit value, whether the page has a unit field], as named in the analysis context.
  const UNIT_COMPANIONS = {
    addressLine1: ['addressLine2', 'hasAddressLine2'],
    mailingAddressLine1: ['mailingAddressLine2', 'hasMailingAddressLine2'],
    businessAddressLine1: ['businessAddressLine2', 'hasBusinessAddressLine2'],
  };

  function formatStreetWithUnit(rawValue, field, context, purpose) {
    const [unitKey, hasUnitFieldKey] = UNIT_COMPANIONS[purpose];
    const unit = context[unitKey];
    if (context[hasUnitFieldKey] || !unit) return null;
    return {
      value: [rawValue, unit].filter(Boolean).join(', '),
      changed: true,
      detail: 'Street and apartment are combined because the form has one address box',
    };
  }

  function formatYesNo(rawValue) {
    return { value: booleanWord(rawValue) };
  }

  // Purposes of one kind share a formatter; a formatter returns the parts of the write it reshapes, or null.
  const VALUE_FORMAT_KINDS = [
    [['state', 'mailingState', 'businessState', 'stateOfFormation'], formatStateCode],
    [['dateOfBirth', 'ihssHouseholdMemberDateOfBirth', 'incorporationDate'], formatDate],
    [['phone', 'businessPhone'], formatPhone],
    [['ssn', 'ihssHouseholdMemberSsn'], formatSsnDigits],
    [['addressLine1', 'mailingAddressLine1', 'businessAddressLine1'], formatStreetWithUnit],
    [YES_NO_PURPOSES, formatYesNo],
  ];
  const VALUE_FORMATTERS = new Map(VALUE_FORMAT_KINDS.flatMap(([purposes, format]) => purposes.map((purpose) => [purpose, format])));

  // A select or choice group takes the value of the option that matches the formatted text.
  function withMatchingOption(formatted, field) {
    const options = field.options || field.members || [];
    const matched = options.length ? matchingOption(options, formatted.value) : null;
    if (matched === null) return formatted;
    return { ...formatted, value: matched, changed: formatted.changed || normalize(matched) !== normalize(formatted.value) };
  }

  function formatForField(purpose, rawValue, field, context) {
    const format = VALUE_FORMATTERS.get(purpose);
    const reshapedParts = format ? format(rawValue, field, context, purpose) : null;
    const formatted = withMatchingOption({ value: rawValue, changed: false, detail: 'from the client record', ...reshapedParts }, field);
    return { value: String(formatted.value), changed: formatted.changed, detail: formatted.detail };
  }

  // ---- Analysis: what to write, what to keep, and what to ask the caseworker ----

  function currentFieldValue(field) {
    if (field.members?.length) {
      const selected = field.members.find((member) => member.checked);
      return selected?.value || selected?.optionLabel || '';
    }
    if (field.type === 'checkbox' || field.type === 'radio') return field.checked ? field.value || 'yes' : '';
    return field.value || '';
  }

  function valuesEquivalent(expected, actual, field) {
    if (expected === undefined || expected === null) return actual === '' || actual === undefined || actual === null;
    const expectedText = String(expected);
    const actualText = String(actual ?? '');
    if (!actualText) return false;
    if (normalize(expectedText) === normalize(actualText)) return true;
    const expectsDigits = ['tel', 'date', 'password'].includes(field?.type) || /ssn|social security|birth|phone|telephone/i.test(field?.label || '');
    if (expectsDigits) {
      const left = expectedText.replace(/\D/g, '');
      const right = actualText.replace(/\D/g, '');
      return Boolean(left) && left === right;
    }
    return false;
  }

  function groupMembers(fields, field) {
    return fields
      .map((candidate, candidateIndex) => ({ candidate, candidateIndex }))
      .filter(({ candidate }) => candidate.type === field.type && candidate.groupKey === field.groupKey);
  }

  function isYesNoCheckboxPair(members) {
    return members.length === 2
      && members.every(({ candidate }) => /^(yes|no|y|n|true|false)$/i.test(normalize(candidate.optionLabel || candidate.label)));
  }

  function choiceField(field, members) {
    return {
      ...field,
      fieldKey: field.groupKey,
      label: field.question || field.label,
      question: field.question || field.label,
      members: members.map(({ candidate }) => ({
        fieldKey: candidate.fieldKey,
        value: candidate.optionValue ?? candidate.value,
        optionLabel: candidate.optionLabel || candidate.label,
        checked: candidate.checked,
      })),
    };
  }

  // Radios and yes/no checkbox pairs become one choice field; other checkbox groups stay independent checkboxes.
  function groupedFields(field, members) {
    if (field.type === 'checkbox' && members.length > 1 && !isYesNoCheckboxPair(members)) {
      return members.map(({ candidate }) => ({ ...candidate, groupKey: '' }));
    }
    if (members.length === 1 && field.type === 'checkbox') return [field];
    return [choiceField(field, members)];
  }

  function combineGroups(fields) {
    const result = [];
    const consumed = new Set();
    fields.forEach((field, index) => {
      if (consumed.has(index)) return;
      if (!['radio', 'checkbox'].includes(field.type) || !field.groupKey) {
        result.push(field);
        return;
      }
      const members = groupMembers(fields, field);
      members.forEach(({ candidateIndex }) => consumed.add(candidateIndex));
      result.push(...groupedFields(field, members));
    });
    return result;
  }

  function displayLabel(field, purpose) {
    return field.question || field.label || LABELS[purpose] || 'Form field';
  }

  function questionFor(field, purpose) {
    if (field.question) return field.question.replace(/\s*\u2014\s*(yes|no)$/i, '');
    const label = displayLabel(field, purpose).replace(/\s*\(required\)\s*/i, '').trim();
    if (field.type === 'checkbox' && !field.members?.length) return label.endsWith('?') ? label : `Should I select ${label.toLowerCase()}?`;
    if (field.type === 'select-one' || field.members?.length) return label.endsWith('?') ? label : `What should I select for ${label.toLowerCase()}?`;
    return label.endsWith('?') ? label : `What is the client's ${label.toLowerCase()}?`;
  }

  function gapInput(field) {
    if (field.type === 'checkbox' && !field.members?.length) {
      return {
        inputType: 'choice',
        options: [
          { value: 'yes', label: 'Yes' },
          { value: 'no', label: 'No' },
        ],
      };
    }
    return {
      inputType: field.members?.length || field.type === 'select-one' ? 'choice' : 'text',
      options: field.members || field.options || [],
    };
  }

  function combineDecisionGroupGaps(gaps, fields) {
    const byFieldKey = new Map(fields.map((field) => [field.fieldKey, field]));
    const groups = new Map();
    const passthrough = [];
    gaps.forEach((gap) => {
      const field = byFieldKey.get(gap.fieldKey);
      if (!field?.decisionGroupKey || field.type !== 'checkbox') {
        passthrough.push(gap);
        return;
      }
      const group = groups.get(field.decisionGroupKey) || {
        fieldKey: `decision:${field.decisionGroupKey}`,
        label: field.decisionGroupQuestion || field.question || field.label,
        question: field.decisionGroupQuestion || field.question || field.label,
        kind: 'multi_decision',
        required: false,
        inputType: 'multi_choice',
        options: [],
        members: [],
        sensitive: false,
      };
      group.required = group.required || Boolean(gap.required);
      group.sensitive = group.sensitive || Boolean(gap.sensitive);
      group.options.push({ value: gap.fieldKey, label: field.optionLabel || field.label });
      group.members.push({
        fieldKey: gap.fieldKey,
        purpose: gap.purpose || '',
        label: field.optionLabel || field.label,
        sensitive: Boolean(gap.sensitive),
      });
      groups.set(field.decisionGroupKey, group);
    });
    return [...passthrough, ...groups.values()];
  }

  function confirmationField(field) {
    const signal = [field.label, field.question, field.name, field.id, field.placeholder]
      .filter(Boolean)
      .map((value) => String(value).replace(/([a-z])([A-Z])/g, '$1 $2'))
      .join(' ');
    return /\bconfirm(?:ation)?\b|\bre enter\b|\breenter\b|\bretype\b|\benter again\b|\bagain\b/.test(normalize(signal));
  }

  function scalarConfirmationGroup(fields) {
    if (fields.length < 2) return false;
    if (fields.some((field) => field.members?.length || ['radio', 'checkbox', 'select-one'].includes(field.type))) return false;
    if (fields.filter((field) => !confirmationField(field)).length !== 1) return false;
    const types = fields.map((field) => String(field.type || 'text').toLowerCase());
    return types.every((type) => type === types[0]);
  }

  // A purpose per field: the caller's override when it names one (an unknown purpose leaves the field unmapped),
  // otherwise the classifier, unless the caller requires overrides.
  function resolvePurposes(fields, options) {
    const purposeOverrides = options?.purposeOverrides || {};
    const requirePurposeOverrides = options?.requirePurposeOverrides === true;
    return fields.map((field) => {
      if (!Object.prototype.hasOwnProperty.call(purposeOverrides, field.fieldKey)) {
        return requirePurposeOverrides ? '' : classifyField(field);
      }
      const purpose = String(purposeOverrides[field.fieldKey] || '');
      return Object.prototype.hasOwnProperty.call(LABELS, purpose) ? purpose : '';
    });
  }

  // A purpose that several fields share is unsafe to fill from one record value unless an adapter allowed the
  // repeat or the fields are one value plus its confirmation.
  function isUnsafeRepeat(matches) {
    return matches.length > 1
      && !matches.every((field) => field.allowRepeatedPurpose === true)
      && !scalarConfirmationGroup(matches);
  }

  function unsafeRepeatedPurposes(fields, purposes) {
    const fieldsByPurpose = new Map();
    purposes.forEach((purpose, fieldIndex) => {
      if (purpose) fieldsByPurpose.set(purpose, [...(fieldsByPurpose.get(purpose) || []), fields[fieldIndex]]);
    });
    return new Set([...fieldsByPurpose].filter(([, matches]) => isUnsafeRepeat(matches)).map(([purpose]) => purpose));
  }

  // Whether the page has its own unit fields; a street value absorbs the unit only when it does not.
  function formatContext(fields, values) {
    const hasClassifiedField = (purpose) => fields.some((field) => classifyField(field) === purpose);
    return {
      hasAddressLine2: hasClassifiedField('addressLine2'),
      addressLine2: values.addressLine2,
      hasBusinessAddressLine2: hasClassifiedField('businessAddressLine2'),
      businessAddressLine2: values.businessAddressLine2,
      hasMailingAddressLine2: hasClassifiedField('mailingAddressLine2'),
      mailingAddressLine2: values.mailingAddressLine2,
    };
  }

  function isSensitive(field, purpose) {
    return SENSITIVE_PURPOSES.has(purpose) || Boolean(field.sensitive);
  }

  function pageObservation(field, purpose, value, detail) {
    return {
      fieldKey: field.fieldKey,
      label: displayLabel(field, purpose),
      value,
      source: 'page',
      detail,
      sensitive: isSensitive(field, purpose),
    };
  }

  function fieldGap(field, purpose, details) {
    const input = gapInput(field);
    return {
      fieldKey: field.fieldKey,
      label: displayLabel(field, purpose),
      ...details,
      inputType: input.inputType,
      options: input.options,
      sensitive: isSensitive(field, purpose),
    };
  }

  function planUnmappedField(plan, field) {
    const current = currentFieldValue(field);
    if (current) {
      plan.observed.push(pageObservation(field, null, current, 'Already in the form; the assistant did not change it'));
    } else if (field.required) {
      plan.gaps.push(fieldGap(field, null, {
        question: questionFor(field, null),
        kind: field.members?.length ? 'decision' : 'required',
        required: true,
      }));
    }
  }

  function planEntityScopeGap(plan, field, purpose) {
    plan.gaps.push(fieldGap(field, purpose, {
      purpose,
      question: `Which person or record does ${displayLabel(field, purpose).toLowerCase()} belong to?`,
      reason: 'The source value has no verified person or entity scope for this repeated field.',
      kind: 'entity_scope',
      required: Boolean(field.required),
    }));
  }

  // A single checkbox whose checked state already says what the record says.
  function checkboxAlreadyMatches(field, value) {
    const word = normalize(value);
    return field.type === 'checkbox' && !field.members?.length && /^(?:yes|no)$/.test(word) && Boolean(field.checked) === (word === 'yes');
  }

  function planRecordValue(plan, field, purpose, rawValue) {
    const formatted = formatForField(purpose, rawValue, field, plan.context);
    const current = currentFieldValue(field);
    const matchesRecord = 'Already in the form and matches the client record';
    if (checkboxAlreadyMatches(field, formatted.value)) {
      plan.observed.push(pageObservation(field, purpose, field.checked ? 'yes' : 'no', matchesRecord));
    } else if (current && valuesEquivalent(formatted.value, current, field)) {
      plan.observed.push(pageObservation(field, purpose, current, matchesRecord));
    } else {
      plan.assignments.push({
        fieldKey: field.fieldKey,
        label: displayLabel(field, purpose),
        purpose,
        value: formatted.value,
        source: formatted.changed ? 'changed' : 'record',
        detail: formatted.detail,
        sensitive: isSensitive(field, purpose),
        fieldType: field.type,
      });
    }
  }

  // No record value: ask when the field is required, is a choice, or holds a value that must never be derived.
  function planMissingValue(plan, field, purpose) {
    const decision = Boolean(field.members?.length || field.type === 'select-one' || DO_NOT_DERIVE.has(purpose));
    if (!field.required && !decision) return;
    plan.gaps.push(fieldGap(field, purpose, {
      purpose,
      question: questionFor(field, purpose),
      kind: decision ? 'decision' : 'required',
      required: Boolean(field.required),
    }));
  }

  function planField(plan, field, purpose) {
    if (!purpose) {
      planUnmappedField(plan, field);
      return;
    }
    plan.usedPurposes.add(purpose);
    const rawValue = plan.values[purpose];
    if (!hasValue(rawValue)) planMissingValue(plan, field, purpose);
    else if (plan.unsafeRepeatedPurposes.has(purpose)) planEntityScopeGap(plan, field, purpose);
    else planRecordValue(plan, field, purpose, rawValue);
  }

  function unusedRecordValues(values, usedPurposes) {
    return Object.entries(values)
      .filter(([purpose, value]) => hasValue(value) && !usedPurposes.has(purpose))
      .map(([purpose, value]) => ({ purpose, label: LABELS[purpose] || purpose, value }));
  }

  function buildAnalysis(rawFields, payload, options = {}) {
    const participant = canonicalizeParticipant(payload);
    const fields = combineGroups((rawFields || []).filter((field) => !field.ignored));
    const purposes = resolvePurposes(fields, options);
    const plan = {
      values: participant.values,
      unsafeRepeatedPurposes: unsafeRepeatedPurposes(fields, purposes),
      context: formatContext(fields, participant.values),
      assignments: [], gaps: [], observed: [], usedPurposes: new Set(),
    };
    fields.forEach((field, fieldIndex) => planField(plan, field, purposes[fieldIndex]));
    const gaps = combineDecisionGroupGaps(plan.gaps, fields);
    const noFields = unusedRecordValues(participant.values, plan.usedPurposes);

    return {
      participant: { name: participant.name, recordId: participant.recordId },
      assignments: plan.assignments,
      gaps,
      observed: plan.observed,
      noFields,
      counts: {
        fields: fields.length,
        ready: plan.assignments.length + plan.observed.length,
        missing: gaps.length,
        unused: noFields.length,
      },
    };
  }

  const api = {
    LABELS,
    buildAnalysis,
    canonicalizeParticipant,
    classifyField,
    compact,
    formatForField,
    normalize,
    valuesEquivalent,
  };

  root.NavaFormEngine = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
