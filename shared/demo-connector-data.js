// Fictional Apricot-shaped connector form (source 99) and demo record 339619, shared by the local mock connector service and the side-panel preview.
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

  const api = { FORM_ID, RECORD_ID, SCHEMA, recordAttributes };

  root.NavaDemoConnectorData = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
