// Canonicalizes a client record of any supported shape into one value per purpose, deriving name and business, residential and mailing address values.
(function installParticipantRecord(root) {
  'use strict';

  // The purpose vocabulary: the global its script installs first, or its CommonJS export under Node.
  const { LABELS, normalize } = root.NavaFormPurposes
    || (typeof module !== 'undefined' ? require('./form-purposes.js') : undefined);

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

  const api = {
    canonicalizeParticipant,
    hasValue,
  };

  root.NavaParticipantRecord = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
