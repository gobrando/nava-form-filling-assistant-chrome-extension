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
    'housingStatus',
    'preferredContact',
    'householdSize',
    'immigrationStatus',
    'income',
    'childcare',
    'unemployment',
    'ein',
  ]);

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

  function getPath(object, path) {
    return path.split('.').reduce((value, part) => value?.[part], object);
  }

  function firstValue(object, paths) {
    for (const path of paths) {
      const value = getPath(object, path);
      if (value !== undefined && value !== null && value !== '') return value;
    }
    return undefined;
  }

  function sameAddress(first, second) {
    if (!first || !second) return undefined;
    const keys = ['street', 'unit', 'city', 'state', 'zip'];
    if (!keys.some((key) => first[key] || second[key])) return undefined;
    return keys.every((key) => normalize(first[key]) === normalize(second[key]));
  }

  function canonicalizeParticipant(payload) {
    const record = payload || {};
    const residential = firstValue(record, ['address.residential', 'residentialAddress']) || {};
    const mailing = firstValue(record, ['address.mailing', 'mailingAddress']) || {};
    const businessAddress = firstValue(record, ['businessAddress', 'business.address', 'company.address']) || {};
    const firstName = firstValue(record, ['firstName', 'first_name', 'participant.name.first', 'name.first']);
    const middleName = firstValue(record, ['middleName', 'middle_name', 'participant.name.middle', 'name.middle']);
    const lastName = firstValue(record, ['lastName', 'last_name', 'participant.name.last', 'name.last']);
    const fullName = [firstName, middleName, lastName].filter(Boolean).join(' ');
    const businessName = firstValue(record, ['businessName', 'business_name', 'business.legalName', 'company.legalName', 'company.name']);
    const businessAddressLine1 = firstValue(record, ['businessAddressLine1', 'business_address_line_1'])
      || firstValue(businessAddress, ['street', 'line1', 'addressLine1']);
    const businessAddressLine2 = firstValue(record, ['businessAddressLine2', 'business_address_line_2'])
      || firstValue(businessAddress, ['unit', 'line2', 'addressLine2']);
    const businessCity = firstValue(record, ['businessCity', 'business_city']) || businessAddress.city;
    const businessState = firstValue(record, ['businessState', 'business_state']) || businessAddress.state;
    const businessPostalCode = firstValue(record, ['businessPostalCode', 'business_postal_code', 'businessZip', 'business_zip'])
      || firstValue(businessAddress, ['postalCode', 'zip']);
    const businessOnly = Boolean(businessName && !firstName && !lastName);
    const values = {
      recordId: firstValue(record, ['record_id', 'recordId', 'id']),
      firstName,
      middleName,
      lastName,
      fullName: fullName || firstValue(record, ['fullName', 'name']),
      dateOfBirth: firstValue(record, ['dateOfBirth', 'date_of_birth', 'participant.date_of_birth', 'dob']),
      ssn: firstValue(record, ['ssn', 'socialSecurityNumber', 'participant.ssn']),
      email: firstValue(record, ['email', 'contact_information.email', 'contact.email']),
      phone: firstValue(record, [
        'phone', 'contact_information.phones.cell', 'contact_information.phones.main',
        'contact_information.phones.home', 'contact.phone',
      ]),
      addressLine1: firstValue(record, ['addressLine1', 'address.street', 'address.residential.street', 'residentialAddress.street'])
        || (businessOnly ? businessAddressLine1 : undefined),
      addressLine2: firstValue(record, ['addressLine2', 'address.unit', 'address.residential.unit', 'residentialAddress.unit'])
        || (businessOnly ? businessAddressLine2 : undefined),
      city: firstValue(record, ['city', 'address.city', 'address.residential.city', 'residentialAddress.city'])
        || (businessOnly ? businessCity : undefined),
      state: firstValue(record, ['state', 'address.state', 'address.residential.state', 'residentialAddress.state'])
        || (businessOnly ? businessState : undefined),
      county: firstValue(record, ['county', 'address.county', 'address.residential.county', 'residentialAddress.county'])
        || (businessOnly ? businessAddress.county : undefined),
      postalCode: firstValue(record, ['postalCode', 'zip', 'address.zip', 'address.residential.zip', 'residentialAddress.zip'])
        || (businessOnly ? businessPostalCode : undefined),
      country: firstValue(record, ['country', 'address.country', 'address.residential.country', 'residentialAddress.country'])
        || (businessOnly ? businessAddress.country : undefined),
      gender: firstValue(record, ['gender', 'sex', 'participant.gender']),
      ethnicity: firstValue(record, ['ethnicity', 'participant.ethnicity']),
      primaryLanguage: firstValue(record, ['primaryLanguage', 'primary_language', 'participant.primary_language']),
      maritalStatus: firstValue(record, ['maritalStatus', 'marital_status', 'participant.marital_status']),
      specialNeeds: firstValue(record, ['specialNeeds', 'special_needs', 'participant.special_needs']),
      farmWorker: firstValue(record, ['farmWorker', 'farm_worker', 'participant.farm_worker']),
      pregnant: firstValue(record, ['pregnant', 'pregnancyStatus', 'participant.pregnant']),
      preferredContact: firstValue(record, ['preferredContact', 'contact_information.preferred_method', 'contact.preferredMethod']),
      housingStatus: firstValue(record, ['housingStatus', 'housing_status', 'participant.housing_status']),
      householdSize: firstValue(record, ['householdSize', 'household_size']),
      immigrationStatus: firstValue(record, ['immigrationStatus', 'immigration_status']),
      income: firstValue(record, ['income', 'monthlyIncome', 'monthly_income']),
      childcare: firstValue(record, ['childcare', 'paysForChildcare', 'pays_for_childcare']),
      unemployment: firstValue(record, ['unemployment', 'appliedForUnemployment', 'applied_for_unemployment']),
      applyCalFresh: firstValue(record, ['applicationSelection.calfresh']),
      applyMediCal: firstValue(record, ['applicationSelection.medical']),
      applyCalWORKs: firstValue(record, ['applicationSelection.calworks']),
      mailingDifferent: sameAddress(residential, mailing) === undefined
        ? undefined
        : !sameAddress(residential, mailing),
      businessName,
      dba: firstValue(record, ['dba', 'doingBusinessAs', 'doing_business_as', 'business.dba', 'company.dba']),
      ein: firstValue(record, ['ein', 'employerIdentificationNumber', 'taxId', 'tax_id', 'business.ein']),
      businessType: firstValue(record, ['businessType', 'business_type', 'entityType', 'entity_type', 'business.type']),
      businessAddressLine1,
      businessAddressLine2,
      businessCity,
      businessState,
      businessPostalCode,
      businessPhone: firstValue(record, ['businessPhone', 'business_phone', 'business.phone', 'company.phone']),
      businessEmail: firstValue(record, ['businessEmail', 'business_email', 'business.email', 'company.email']),
      incorporationDate: firstValue(record, ['incorporationDate', 'formationDate', 'formation_date', 'business.formationDate']),
      stateOfFormation: firstValue(record, ['stateOfFormation', 'state_of_formation', 'business.stateOfFormation']),
    };

    return {
      values,
      labels: LABELS,
      name: fullName || businessName || 'Client',
      recordId: values.recordId,
    };
  }

  function classifyField(field) {
    const signal = normalize([
      field.autocomplete,
      field.question,
      field.label,
      field.name,
      field.id,
      field.placeholder,
    ].filter(Boolean).join(' '));

    const tokens = new Set(signal.split(' ').filter(Boolean));
    const has = (...patterns) => patterns.some((pattern) => signal.includes(pattern));
    const hasWord = (...words) => words.some((word) => tokens.has(word));

    if (signal === 'ein' || has('employer identification', 'federal tax id', 'federal tax identification', 'business tax id')) return 'ein';
    if (signal === 'ssn' || has('social security', ' ssn', 'ssn ')) return 'ssn';
    if (has('calfresh', 'cal fresh')) return 'applyCalFresh';
    if (has('medi cal', 'medi-cal', 'medical benefits')) return 'applyMediCal';
    if (has('calworks', 'cal works')) return 'applyCalWORKs';
    if (has('doing business as', ' dba', 'dba ')) return 'dba';
    if (has('business legal name', 'legal business name', 'company legal name', 'business name', 'company name')) return 'businessName';
    if (has('entity type', 'business type', 'legal structure')) return 'businessType';
    if (has('state of formation', 'state of incorporation', 'formation state')) return 'stateOfFormation';
    if (has('date of formation', 'formation date', 'incorporation date')) return 'incorporationDate';
    if (has('business email', 'company email')) return 'businessEmail';
    if (has('business phone', 'company phone')) return 'businessPhone';
    if (has('business address line 2', 'business apartment', 'business suite', 'company suite')) return 'businessAddressLine2';
    if (has('business address', 'company address', 'business street')) return 'businessAddressLine1';
    if (has('business city', 'company city')) return 'businessCity';
    if (has('business state', 'company state')) return 'businessState';
    if (has('business zip', 'business postal', 'company zip')) return 'businessPostalCode';
    if (has('date of birth', 'birth date', 'birthdate', ' dob ', 'bday')) return 'dateOfBirth';
    if (has('first name', 'given name', 'given-name', 'firstname', 'namefirst')) return 'firstName';
    if (has('middle name', 'additional name', 'additional-name', 'middlename', 'namemiddle')) return 'middleName';
    if (has('last name', 'family name', 'family-name', 'surname', 'lastname', 'namelast')) return 'lastName';
    if (has('full name', 'your name') && !has('organization')) return 'fullName';
    if (has('email')) return 'email';
    if (has('phone', 'telephone', 'mobile', 'tel ')) return 'phone';
    if (has('experiencing homelessness', 'homeless', 'housing status', 'stable housing')) return 'housingStatus';
    if (has('preferred contact', 'contact preference', 'how should we contact', 'best way to contact')) return 'preferredContact';
    if (has('immigration status', 'citizenship status')) return 'immigrationStatus';
    if (has('household size', 'people in household', 'other people living', 'lives alone')) return 'householdSize';
    if (has('monthly household income', 'monthly income', 'gross income', 'income from a job')) return 'income';
    if (has('paying for childcare', 'child care', 'childcare')) return 'childcare';
    if (has('unemployment benefits', 'unemployment')) return 'unemployment';
    if (has('mail at a different address', 'mailing address same', 'same as home', 'same as residential')) return 'mailingDifferent';
    if (has('apartment', 'apt ', 'unit ', 'suite', 'address line 2', 'address-line2')) return 'addressLine2';
    if (has('street address', 'home address', 'residential address', 'address line 1', 'address-line1', 'street')) return 'addressLine1';
    if (has('postal code', 'zip code', 'zipcode', 'postal-code', ' zip ')) return 'postalCode';
    if (hasWord('city') || has('address-level2')) return 'city';
    if (hasWord('county')) return 'county';
    if (hasWord('state', 'province') || has('address-level1')) return 'state';
    if (hasWord('country') || has('country-name')) return 'country';
    if (has('primary language', 'preferred language', 'language')) return 'primaryLanguage';
    if (has('ethnicity', 'hispanic')) return 'ethnicity';
    if (has('gender', 'sex assigned at birth') || hasWord('sex')) return 'gender';
    if (has('marital status', 'married')) return 'maritalStatus';
    if (has('special needs', 'disability', 'disabled')) return 'specialNeeds';
    if (has('farm worker', 'farmworker', 'migrant worker')) return 'farmWorker';
    if (has('pregnant', 'pregnancy')) return 'pregnant';
    if (has('record id', 'client id', 'participant id', 'apricot id')) return 'recordId';
    return null;
  }

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

  function formatForField(purpose, rawValue, field, context) {
    let value = rawValue;
    let changed = false;
    let detail = 'from the client record';

    if (['state', 'businessState', 'stateOfFormation'].includes(purpose)) {
      const stateCode = STATE_CODES[normalize(rawValue)] || String(rawValue).toUpperCase();
      const wantsCode = Number(field.maxLength) === 2 || (field.options || []).some((option) => option.value === stateCode);
      if (wantsCode && stateCode !== rawValue) {
        value = stateCode;
        changed = true;
        detail = `${rawValue} becomes ${stateCode} — the form wants the state code`;
      }
    }

    if (['dateOfBirth', 'incorporationDate'].includes(purpose)) {
      const parts = toDateParts(rawValue);
      if (parts) {
        if (field.type === 'date') value = `${parts.year}-${parts.month}-${parts.day}`;
        else if (Number(field.maxLength) === 8) value = `${parts.month}${parts.day}${parts.year}`;
        else value = `${parts.month}/${parts.day}/${parts.year}`;
        changed = value !== rawValue;
        if (changed) detail = `${rawValue} is written in the form's date format`;
      }
    }

    if (['phone', 'businessPhone'].includes(purpose) && Number(field.maxLength) === 10) {
      const digits = String(rawValue).replace(/\D/g, '');
      if (digits) {
        value = digits;
        changed = value !== rawValue;
        if (changed) detail = 'Phone punctuation is removed so the form can add its own format';
      }
    }

    const companionAddressLine2 = purpose === 'businessAddressLine1' ? context.businessAddressLine2 : context.addressLine2;
    const hasCompanionField = purpose === 'businessAddressLine1' ? context.hasBusinessAddressLine2 : context.hasAddressLine2;
    if (['addressLine1', 'businessAddressLine1'].includes(purpose) && !hasCompanionField && companionAddressLine2) {
      value = [rawValue, companionAddressLine2].filter(Boolean).join(', ');
      changed = true;
      detail = 'Street and apartment are combined because the form has one address box';
    }

    if (['specialNeeds', 'farmWorker', 'pregnant', 'childcare', 'unemployment', 'mailingDifferent', 'applyCalFresh', 'applyMediCal', 'applyCalWORKs'].includes(purpose)) {
      value = booleanWord(rawValue);
    }

    const options = field.options || field.members || [];
    if (options.length) {
      const matched = matchingOption(options, value);
      if (matched !== null) {
        changed = changed || normalize(matched) !== normalize(value);
        value = matched;
      }
    }

    return { value: String(value), changed, detail };
  }

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

  function combineGroups(fields) {
    const result = [];
    const consumed = new Set();
    fields.forEach((field, index) => {
      if (consumed.has(index)) return;
      if (!['radio', 'checkbox'].includes(field.type) || !field.groupKey) {
        result.push(field);
        return;
      }
      const members = fields
        .map((candidate, candidateIndex) => ({ candidate, candidateIndex }))
        .filter(({ candidate }) => candidate.type === field.type && candidate.groupKey === field.groupKey);
      const checkboxBooleanChoice = field.type === 'checkbox'
        && members.length === 2
        && members.every(({ candidate }) => /^(yes|no|y|n|true|false)$/i.test(normalize(candidate.optionLabel || candidate.label)));
      if (field.type === 'checkbox' && members.length > 1 && !checkboxBooleanChoice) {
        members.forEach(({ candidate, candidateIndex }) => {
          consumed.add(candidateIndex);
          result.push({ ...candidate, groupKey: '' });
        });
        return;
      }
      members.forEach(({ candidateIndex }) => consumed.add(candidateIndex));
      if (members.length === 1 && field.type === 'checkbox') {
        result.push(field);
        return;
      }
      result.push({
        ...field,
        fieldKey: field.groupKey,
        label: field.question || field.label,
        question: field.question || field.label,
        members: members.map(({ candidate }) => ({
          fieldKey: candidate.fieldKey,
          value: candidate.value,
          optionLabel: candidate.optionLabel || candidate.label,
          checked: candidate.checked,
        })),
      });
    });
    return result;
  }

  function displayLabel(field, purpose) {
    return field.question || field.label || LABELS[purpose] || 'Form field';
  }

  function questionFor(field, purpose) {
    if (field.question) return field.question.replace(/\s*\u2014\s*(yes|no)$/i, '');
    const label = displayLabel(field, purpose).replace(/\s*\(required\)\s*/i, '').trim();
    if (field.type === 'select-one' || field.members?.length) return label.endsWith('?') ? label : `What should I select for ${label.toLowerCase()}?`;
    return label.endsWith('?') ? label : `What is the client's ${label.toLowerCase()}?`;
  }

  function buildAnalysis(rawFields, payload) {
    const participant = canonicalizeParticipant(payload);
    const fields = combineGroups((rawFields || []).filter((field) => !field.ignored));
    const context = {
      hasAddressLine2: fields.some((field) => classifyField(field) === 'addressLine2'),
      addressLine2: participant.values.addressLine2,
      hasBusinessAddressLine2: fields.some((field) => classifyField(field) === 'businessAddressLine2'),
      businessAddressLine2: participant.values.businessAddressLine2,
    };
    const assignments = [];
    const gaps = [];
    const observed = [];
    const usedPurposes = new Set();

    for (const field of fields) {
      const purpose = classifyField(field);
      const current = currentFieldValue(field);
      const required = Boolean(field.required);

      if (!purpose) {
        if (current) {
          observed.push({
            fieldKey: field.fieldKey,
            label: displayLabel(field),
            value: current,
            source: 'page',
            detail: 'Already in the form; the assistant did not change it',
            sensitive: Boolean(field.sensitive),
          });
        } else if (required) {
          gaps.push({
            fieldKey: field.fieldKey,
            label: displayLabel(field),
            question: questionFor(field),
            kind: field.members?.length ? 'decision' : 'required',
            required: true,
            inputType: field.members?.length ? 'choice' : field.type === 'select-one' ? 'choice' : 'text',
            options: field.members || field.options || [],
            sensitive: Boolean(field.sensitive),
          });
        }
        continue;
      }

      usedPurposes.add(purpose);
      const rawValue = participant.values[purpose];
      if (rawValue !== undefined && rawValue !== null && rawValue !== '') {
        const formatted = formatForField(purpose, rawValue, field, context);
        if (current && valuesEquivalent(formatted.value, current, field)) {
          observed.push({
            fieldKey: field.fieldKey,
            label: displayLabel(field, purpose),
            value: current,
            source: 'page',
            detail: 'Already in the form and matches the client record',
            sensitive: ['ssn', 'ein'].includes(purpose) || Boolean(field.sensitive),
          });
        } else {
          assignments.push({
            fieldKey: field.fieldKey,
            label: displayLabel(field, purpose),
            purpose,
            value: formatted.value,
            source: formatted.changed ? 'changed' : 'record',
            detail: formatted.detail,
            sensitive: ['ssn', 'ein'].includes(purpose) || Boolean(field.sensitive),
            fieldType: field.type,
          });
        }
        continue;
      }

      const decision = Boolean(field.members?.length || field.type === 'select-one' || DO_NOT_DERIVE.has(purpose));
      if (required || decision) {
        gaps.push({
          fieldKey: field.fieldKey,
          label: displayLabel(field, purpose),
          purpose,
          question: questionFor(field, purpose),
          kind: decision ? 'decision' : 'required',
          required,
          inputType: field.members?.length || field.type === 'select-one' ? 'choice' : 'text',
          options: field.members || field.options || [],
          sensitive: ['ssn', 'ein'].includes(purpose) || Boolean(field.sensitive),
        });
      }
    }

    const noFields = Object.entries(participant.values)
      .filter(([purpose, value]) => value !== undefined && value !== null && value !== '' && !usedPurposes.has(purpose))
      .map(([purpose, value]) => ({ purpose, label: LABELS[purpose] || purpose, value }));

    return {
      participant: { name: participant.name, recordId: participant.recordId },
      assignments,
      gaps,
      observed,
      noFields,
      counts: {
        fields: fields.length,
        ready: assignments.length + observed.length,
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
