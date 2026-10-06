// What a planner may see: the bounded, grouped page inventory with participant values redacted, and the value-free list of source purposes on file.
(function installPlannerInventory(root) {
  'use strict';

  function compactText(value, limit = 240) {
    return String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit);
  }

  // The bounded description of one page control that a model may see: it records whether the control
  // is filled, never its value (participant values in its text are redacted later by redactSourceValues).
  // A singleton group keeps its own writable field key; a real group is keyed by the group.
  function inventoryEntry(field, singletonGroup) {
    return {
      fieldKey: compactText(singletonGroup ? field.fieldKey : (field.groupKey || field.fieldKey), 180),
      type: compactText(field.type, 40),
      label: compactText(field.label),
      question: compactText(field.question),
      required: Boolean(field.required),
      alreadyFilled: Boolean(field.value || field.checked),
      purposeHint: compactText(field.purpose, 100),
      allowRepeatedPurpose: Boolean(field.allowRepeatedPurpose),
      options: [],
    };
  }

  function standaloneOptions(field) {
    return (field.options || []).slice(0, 80).map((option) => compactText(option.label || option.value, 120));
  }

  // Folds one radio/checkbox group member into the group's entry: the group is required or filled
  // when any member is, and each member contributes its option text.
  function mergeGroupMember(groupEntry, memberEntry, field) {
    groupEntry.required = groupEntry.required || memberEntry.required;
    groupEntry.alreadyFilled = groupEntry.alreadyFilled || memberEntry.alreadyFilled;
    groupEntry.question = groupEntry.question || memberEntry.question;
    groupEntry.purposeHint = groupEntry.purposeHint || memberEntry.purposeHint;
    groupEntry.options.push(compactText(field.optionLabel || field.optionValue || field.label, 120));
    return groupEntry;
  }

  function groupedInventory(rawFields) {
    const groups = new Map();
    const singles = [];
    const groupCounts = new Map();
    (rawFields || []).forEach((field) => {
      if (!field.groupKey) return;
      groupCounts.set(field.groupKey, (groupCounts.get(field.groupKey) || 0) + 1);
    });
    (rawFields || []).forEach((field) => {
      const singletonGroup = field.groupKey && groupCounts.get(field.groupKey) === 1;
      const entry = inventoryEntry(field, singletonGroup);
      if (!field.groupKey || singletonGroup) {
        entry.options = standaloneOptions(field);
        singles.push(entry);
        return;
      }
      groups.set(field.groupKey, mergeGroupMember(groups.get(field.groupKey) || entry, entry, field));
    });
    const inventory = [...singles, ...groups.values()]
      .slice(0, 80)
      .map((field) => ({ ...field, options: [...new Set(field.options)].filter(Boolean).slice(0, 30) }));
    while (JSON.stringify(inventory).length > 24_000) {
      const optionField = [...inventory]
        .filter((field) => field.options.length > 2)
        .sort((left, right) => right.options.length - left.options.length)[0];
      if (optionField) optionField.options.pop();
      else if (inventory.length > 1) inventory.pop();
      else break;
    }
    return inventory;
  }

  function sourceInventory(engine, participant) {
    const values = engine.canonicalizeParticipant(participant || {}).values;
    return Object.entries(values)
      .filter(([, value]) => value !== undefined && value !== null && value !== '')
      .map(([purpose, value]) => ({
        purpose,
        label: engine.LABELS[purpose] || purpose,
        kind: Array.isArray(value) ? 'list' : typeof value,
        sensitive: /ssn|social security|ein/i.test(`${purpose} ${engine.LABELS[purpose] || ''}`),
      }));
  }

  function redactSourceValues(engine, participant, fields) {
    const values = engine.canonicalizeParticipant(participant || {}).values;
    const terms = Object.values(values)
      .flatMap((value) => Array.isArray(value) ? value : [value])
      .map((value) => String(value ?? '').trim())
      .filter((value) => value.length >= 4)
      .sort((left, right) => right.length - left.length);
    const redact = (text) => terms.reduce((result, term) =>
      result.replace(new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), '[source value]'), String(text || ''));
    return fields.map((field) => ({
      ...field,
      label: redact(field.label),
      question: redact(field.question),
      options: field.options.map(redact),
    }));
  }

  // Everything a planner (local roles or the shared gateway) may see: the bounded page inventory with
  // participant values redacted, and the source purposes on file without their values.
  function planningInventory(engine, participant, rawFields) {
    const fields = redactSourceValues(engine, participant, groupedInventory(rawFields));
    const sources = sourceInventory(engine, participant);
    return { fields, sources };
  }

  const api = {
    compactText,
    groupedInventory,
    planningInventory,
  };

  root.NavaPlannerInventory = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
