// Fictional connector demo data shared by the service worker, the local mock connector service, and the side-panel preview: the Apricot-shaped form (source 99) and record 339619, the bundled client records, and the recertification caseload.
(function installDemoConnectorData(root) {
  'use strict';

  const FORM_ID = 99;
  const RECORD_ID = 339619;

  const SCHEMA = [
    { id: 101, label: 'First Name', type: 'text', reference_tag: 'firstName' },
    { id: 102, label: 'Middle Name', type: 'text', reference_tag: 'middleName' },
    { id: 103, label: 'Last Name', type: 'text', reference_tag: 'lastName' },
    { id: 104, label: 'Date of Birth', type: 'date', reference_tag: 'dateOfBirth' },
    { id: 105, label: 'Primary Email', type: 'email', reference_tag: 'email' },
    { id: 106, label: 'Cell Phone', type: 'phone', reference_tag: 'phone' },
    { id: 107, label: 'Residential Address', type: 'text', reference_tag: 'addressLine1' },
    { id: 108, label: 'Apartment or Unit', type: 'text', reference_tag: 'addressLine2' },
    { id: 109, label: 'Residential City', type: 'text', reference_tag: 'city' },
    { id: 110, label: 'Residential State', type: 'text', reference_tag: 'state' },
    { id: 111, label: 'Residential County', type: 'text', reference_tag: 'county' },
    { id: 112, label: 'ZIP Code', type: 'text', reference_tag: 'postalCode' },
    { id: 113, label: 'Preferred Language', type: 'select', reference_tag: 'primaryLanguage' },
    { id: 114, label: 'Gender', type: 'select', reference_tag: 'gender' },
    { id: 115, label: 'Ethnicity', type: 'select', reference_tag: 'ethnicity' },
    { id: 116, label: 'Marital Status', type: 'select', reference_tag: 'maritalStatus' },
    { id: 117, label: 'Special Needs', type: 'boolean', reference_tag: 'specialNeeds' },
    { id: 118, label: 'Farm Worker', type: 'boolean', reference_tag: 'farmWorker' },
    { id: 119, label: 'Preferred Contact Method', type: 'select', reference_tag: 'preferredContact' },
    { id: 120, label: 'Housing Status', type: 'select', reference_tag: 'housingStatus' },
    { id: 121, label: 'Household Size', type: 'number', reference_tag: 'householdSize' },
    { id: 122, label: 'Citizenship Status', type: 'select', reference_tag: 'immigrationStatus' },
    { id: 123, label: 'Monthly Household Income', type: 'currency', reference_tag: 'income' },
    { id: 124, label: 'Pays for Childcare', type: 'boolean', reference_tag: 'childcare' },
    { id: 125, label: 'Receives Unemployment Benefits', type: 'boolean', reference_tag: 'unemployment' },
    { id: 126, label: 'Pregnancy Status', type: 'boolean', reference_tag: 'pregnant' },
    { id: 127, label: 'Social Security Number', type: 'sensitive', reference_tag: 'ssn' },
    { id: 128, label: 'Residential Country', type: 'text', reference_tag: 'country' },
  ];

  /** Source attributes of fictional record 339619, stamped with the caller's modification time. */
  function recordAttributes(modTime) {
    return {
      form_id: FORM_ID,
      mod_time: modTime,
      field_101: 'Celeste',
      field_102: 'NAVA',
      field_103: 'Thomas II',
      field_104: '2000-01-02',
      field_105: 'testnava@email.com',
      field_106: '777-777-7777',
      field_107: '5556 Test Blvd',
      field_108: 'Apt 556',
      field_109: 'WILDOMAR',
      field_110: 'California',
      field_111: 'Riverside',
      field_112: '92595',
      field_113: 'English',
      field_114: 'Female',
      field_115: 'Hispanic/Latino',
      field_116: 'Single',
      field_117: false,
      field_118: false,
      field_119: 'Email',
      field_120: 'Stable housing',
      field_121: '3',
      field_122: 'U.S. citizen',
      field_123: '1850',
      field_124: true,
      field_125: false,
      field_126: false,
      field_127: '123-45-6789',
      field_128: 'United States',
    };
  }

  // Bundled fictional client records in the extension's record shape, served by the service worker's demo
  // connector when no managed connector is configured.
  const CLIENT_RECORDS = [
    {
      record_id: '339619',
      participant: {
        name: { first: 'Celeste', middle: 'NAVA', last: 'Thomas', suffix: 'II' },
        date_of_birth: '2000-01-02',
        ethnicity: 'Hispanic/Latino',
        gender: 'Female',
        primary_language: 'English',
        special_needs: false,
        marital_status: 'Single parent household',
        farm_worker: false,
        pregnant: false,
        housing_status: 'Stable housing',
        ssn: '123-45-6789',
      },
      contact_information: {
        preferred_method: 'Email',
        phones: { cell: '777-777-7777' },
        email: 'testnava@email.com',
      },
      address: {
        residential: {
          street: '5556 Test Blvd',
          unit: 'Apt 556',
          city: 'WILDOMAR',
          state: 'California',
          county: 'Riverside',
          zip: '92595',
          country: 'United States',
        },
        mailing: {
          street: '5556 Test Blvd',
          unit: 'Apt 556',
          city: 'WILDOMAR',
          state: 'California',
          county: 'Riverside',
          zip: '92595',
          country: 'United States',
        },
      },
      householdSize: '3',
      immigrationStatus: 'U.S. citizen',
      income: '1850',
      childcare: true,
      unemployment: false,
      programData: {
        ihss: {
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
        },
        wic: {
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
        },
      },
    },
    {
      record_id: '338618',
      participant: {
        name: { first: 'Amelie', middle: 'NAVA', last: 'Thomas I' },
        date_of_birth: '2000-01-01',
        ethnicity: 'Hispanic/Latino',
        gender: 'Female',
        primary_language: 'English',
        special_needs: false,
        marital_status: 'Single parent household',
      },
      contact_information: {
        preferred_method: null,
        phones: { cell: '7777777777' },
        email: 'testnava@email.com',
      },
      address: {
        residential: {
          street: '5555 Test Blvd',
          unit: 'Apt 555',
          city: 'BANNING',
          state: 'CA',
          county: 'Riverside',
          zip: '92220',
        },
        mailing: {
          street: '5555 Test Blvd',
          unit: 'Apt 555',
          city: 'BANNING',
          state: 'CA',
          county: 'Riverside',
          zip: '92220',
        },
      },
    },
    {
      record_id: '339637',
      participant: {
        name: { first: 'Sawyer', middle: 'NAVA', last: 'Thomas XX' },
        date_of_birth: '1954-01-10',
        ethnicity: 'Hispanic/Latino',
        gender: 'Male',
        primary_language: 'Spanish',
        special_needs: false,
        marital_status: 'Other',
      },
      contact_information: {
        preferred_method: null,
        phones: { cell: '7777777777' },
        email: 'testnava@email.com',
      },
      address: {
        residential: {
          street: '5574 Test Blvd',
          unit: 'Apt 574',
          city: 'WILDOMAR',
          state: 'CA',
          county: 'Riverside',
          zip: '92505',
        },
        mailing: {
          street: '5574 Test Blvd',
          unit: 'Apt 574',
          city: 'WILDOMAR',
          state: 'CA',
          county: 'Riverside',
          zip: '92505',
        },
      },
    },
  ];

  // Fictional recertification caseload. Due dates are day offsets, so every case stays the same distance from today.
  const RECERTIFICATION_CASELOAD = [
    {
      recordId: '339637', displayName: 'Sawyer Thomas XX', firstName: 'Sawyer',
      programId: 'calworks', programName: 'CalWORKs', dueInDays: -3, preferredContact: 'Phone',
      requirements: {
        contact: { status: 'current' }, household: { status: 'confirmed' }, income: { status: 'current' },
        expenses: { status: 'confirmed' }, documents: { status: 'current' },
      },
    },
    {
      recordId: '339619', displayName: 'Celeste Thomas II', firstName: 'Celeste',
      programId: 'calfresh', programName: 'CalFresh', dueInDays: 12, preferredContact: 'Email',
      requirements: {
        contact: { status: 'current' }, household: { status: 'missing' }, income: { status: 'stale' },
        expenses: { status: 'missing' }, documents: { status: 'missing' },
      },
    },
    {
      recordId: '338618', displayName: 'Amelie Thomas I', firstName: 'Amelie',
      programId: 'medical', programName: 'Medi-Cal', dueInDays: 33, preferredContact: 'Email',
      requirements: {
        contact: { status: 'stale' }, household: { status: 'missing' }, income: { status: 'missing' },
        expenses: { status: 'missing' }, documents: { status: 'missing' },
      },
    },
  ];

  /** The UTC calendar date `days` after the UTC date of `now`, as YYYY-MM-DD. */
  function isoDateOffset(days, now = new Date()) {
    const base = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    base.setUTCDate(base.getUTCDate() + days);
    return base.toISOString().slice(0, 10);
  }

  /**
   * One caseload entry as a connector serves it, in connector field order: the id is the serving connector's
   * prefix plus record and program (for example 'demo-recert-339619-calfresh'), and the due date falls
   * `dueInDays` after `now`. Each call returns a fresh case.
   */
  function recertificationCase(entry, idPrefix, now = new Date()) {
    return {
      id: `${idPrefix}-${entry.recordId}-${entry.programId}`,
      recordId: entry.recordId,
      displayName: entry.displayName,
      firstName: entry.firstName,
      programId: entry.programId,
      programName: entry.programName,
      dueDate: isoDateOffset(entry.dueInDays, now),
      preferredContact: entry.preferredContact,
      requirements: structuredClone(entry.requirements),
    };
  }

  const api = {
    FORM_ID,
    RECORD_ID,
    SCHEMA,
    recordAttributes,
    CLIENT_RECORDS,
    RECERTIFICATION_CASELOAD,
    isoDateOffset,
    recertificationCase,
  };

  root.NavaDemoConnectorData = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
