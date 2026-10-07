// Formats a record value into the shape a form field expects (state code, date, phone, SSN, street plus unit, yes/no, matching option) and compares a field's current value with an expected one.
(function installFieldValues(root) {
  'use strict';

  // The purpose vocabulary: the global its script installs first, or its CommonJS export under Node.
  const { YES_NO_PURPOSES, normalize } = root.NavaFormPurposes
    || (typeof module !== 'undefined' ? require('./form-purposes.js') : undefined);

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

  // ---- Field values on the page: what a field holds now, and whether it holds the expected value ----

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

  const api = {
    currentFieldValue,
    formatForField,
    valuesEquivalent,
  };

  root.NavaFieldValues = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
