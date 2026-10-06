// Form engine: builds the fill analysis (assignments, gaps, observed values) the side panel and page agent act on, and publishes the engine API over the purpose, participant-record and field-value modules.
(function installFormEngine(root) {
  'use strict';

  // The modules the engine composes: the globals their scripts install first, or their CommonJS exports under Node.
  const { DO_NOT_DERIVE, LABELS, SENSITIVE_PURPOSES, classifyField, compact, normalize } = root.NavaFormPurposes
    || (typeof module !== 'undefined' ? require('./form-purposes.js') : undefined);
  const { canonicalizeParticipant, hasValue } = root.NavaParticipantRecord
    || (typeof module !== 'undefined' ? require('./participant-record.js') : undefined);
  const { currentFieldValue, formatForField, valuesEquivalent } = root.NavaFieldValues
    || (typeof module !== 'undefined' ? require('./field-values.js') : undefined);

  // ---- Analysis: what to write, what to keep, and what to ask the caseworker ----

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
