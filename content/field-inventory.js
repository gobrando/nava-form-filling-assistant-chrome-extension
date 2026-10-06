// Field inventory for the page agent: which visible controls are in scope (credentials, payment data, attestations, and decoys never are), each control's question, requiredness, options, and current value, the site-policy merge, choice-group keys, and the scan that rebuilds the field and group maps.
(function installPageFieldInventory(root) {
  'use strict';

  const IGNORED_INPUT_TYPES = new Set(['hidden', 'submit', 'button', 'reset', 'image', 'file', 'search']);

  /**
   * deps:
   * - engine: the form engine (normalize, compact).
   * - siteAdapters(): the bundled site adapters installed in this page, read at each scan; may be absent.
   * - dom: the page DOM helpers (cleanText, fieldVisible, associatedLabel, questionText, labelFor).
   * - fieldMap, groupMap: the agent-owned maps a scan clears and refills (field key → element, group key → members).
   * - nextScanNumber(): advances the agent-owned scan counter and returns the new value.
   */
  function create(deps) {
    const { engine, siteAdapters, dom, fieldMap, groupMap, nextScanNumber } = deps;
    const { cleanText, fieldVisible, associatedLabel, questionText, labelFor } = dom;

    function looksSensitive(element, label) {
      const signal = engine.normalize(`${label} ${element.name || ''} ${element.id || ''} ${element.autocomplete || ''}`);
      return /social security|\bssn\b|employer identification|\bein\b|tax id|bank account|routing number|credit card|card number|passport|immigration/.test(signal)
        || element.type === 'password';
    }

    // Credentials, one-time codes, and payment data are never written. A
    // password-masked SSN or birthdate field stays in scope.
    function isCredentialOrPaymentField(type, autocomplete, signal) {
      return /current-password|new-password|one-time-code|cc-number|cc-csc|cc-exp/.test(autocomplete)
        || (type === 'password' && !/social security|\bssn\b|date of birth|birth date|birthdate/.test(signal))
        || /credit card|card number|security code|\bcvv\b|routing number|bank account|payment account/.test(signal);
    }

    // Attestations stay with the caseworker; honeypots, site search, and CAPTCHA
    // widgets are not application answers.
    function isAttestationOrDecoyField(element, type, signal) {
      return (type === 'checkbox' && /certif|attest|affirm|declaration|signature|terms and conditions|under penalty/.test(signal))
        || /leave this field blank|do not fill|honeypot|website url|site search|search this site/.test(signal)
        || Boolean(element.closest('[role="search"], .search-form, .site-search, .g-recaptcha'));
    }

    function shouldIgnore(element, label) {
      if (!fieldVisible(element) || element.disabled) return true;
      const type = String(element.type || '').toLowerCase();
      if (IGNORED_INPUT_TYPES.has(type)) return true;
      const autocomplete = String(element.autocomplete || '').toLowerCase();
      const signal = engine.normalize(`${label} ${element.name || ''} ${element.id || ''} ${autocomplete}`);
      return isCredentialOrPaymentField(type, autocomplete, signal) || isAttestationOrDecoyField(element, type, signal);
    }

    function requiredNodeSignal(node) {
      if (!node) return false;
      const className = typeof node.className === 'string' ? node.className : '';
      const text = cleanText(node.textContent);
      return node.required === true
        || node.getAttribute?.('aria-required') === 'true'
        || /(?:^|\s)(?:required|form-required)(?:\s|$)/i.test(className)
        || /(?:^|\s)required(?:\s|$)/i.test(text)
        || /\*$/.test(text);
    }

    function requiredField(element, label, question, policy = {}) {
      const group = element.closest?.('fieldset, [role="radiogroup"], [role="group"]');
      const groupHeading = group?.querySelector?.(':scope > legend, :scope > .question, :scope > .form-label, :scope > label');
      return policy.required === true
        || requiredNodeSignal(element)
        || requiredNodeSignal(associatedLabel(element))
        || requiredNodeSignal(group)
        || requiredNodeSignal(groupHeading)
        || /(?:^|\s)required(?:\s|$)/i.test(`${label} ${question}`)
        || /\*$/.test(label.trim());
    }

    function placeholderOption(option) {
      const value = engine.normalize(option?.value);
      const label = engine.normalize(cleanText(option?.textContent));
      if (!value || option?.disabled || option?.hidden) return true;
      if (/^(?:-+\s*)?(?:please\s+)?(?:select|choose)(?:\s+(?:one|an option|a value))?(?:\s*-+)?$/.test(label)) return true;
      return ['sel', 'select', '-1'].includes(value) && /select|choose/.test(label);
    }

    function selectOptions(element) {
      return [...element.options]
        .filter((option) => !placeholderOption(option))
        .map((option) => ({ value: option.value, label: cleanText(option.textContent) }));
    }

    function rawCurrentValue(element) {
      if (element.type === 'checkbox' || element.type === 'radio') return element.checked ? element.value || 'yes' : '';
      if (element.tagName === 'SELECT') {
        const selected = [...(element.options || [])].find((option) => String(option.value) === String(element.value));
        if (selected && placeholderOption(selected)) return '';
      }
      return element.value || '';
    }

    function isChoiceControl(element) {
      return ['radio', 'checkbox'].includes(element.type);
    }

    // Site-policy merge: the bundled adapter for this host may scope, relabel,
    // regroup, or ignore a control. No adapter means an empty policy.
    function sitePolicyFor(element, label, question) {
      return siteAdapters()?.fieldPolicy?.(location.hostname, location.pathname, {
        id: element.id || '',
        name: element.name || '',
        value: element.value || '',
        className: typeof element.className === 'string' ? element.className : '',
        type: String(element.type || '').toLowerCase(),
        label,
        question,
      }) || {};
    }

    function sharesQuestionWithAnotherControl(element, question, elements) {
      return Boolean(question) && elements.some((candidate) => candidate !== element
        && candidate.type === element.type
        && questionText(candidate, labelFor(candidate)) === question);
    }

    // Choice controls group by name; nameless ones group when another control of
    // the same type asks the same question.
    function inferredGroupKey(element, question, elements) {
      if (!isChoiceControl(element)) return '';
      if (!element.name && !sharesQuestionWithAnotherControl(element, question, elements)) return '';
      return `group:${element.type}:${element.name || engine.compact(question)}`;
    }

    function groupKeyFor(policy, element, question, elements) {
      if (Object.prototype.hasOwnProperty.call(policy, 'groupKey')) return String(policy.groupKey || '');
      return inferredGroupKey(element, question, elements);
    }

    function optionValueFor(policy, element) {
      return Object.prototype.hasOwnProperty.call(policy, 'optionValue')
        ? String(policy.optionValue ?? '')
        : String(element.value || '');
    }

    function describedType(element, policy) {
      return policy.type || (element.tagName === 'SELECT' ? 'select-one' : String(element.type || 'text').toLowerCase());
    }

    function controlIdentity(element, policy) {
      return {
        tag: element.tagName.toLowerCase(),
        type: describedType(element, policy),
        id: element.id || '',
        name: element.name || '',
      };
    }

    function policyAnnotations(policy) {
      return {
        purpose: policy.purpose || '',
        decisionGroupKey: String(policy.decisionGroupKey || ''),
        decisionGroupQuestion: cleanText(policy.decisionGroupQuestion || ''),
        unmapped: policy.unmapped === true,
        allowRepeatedPurpose: policy.allowRepeatedPurpose === true,
        exclusive: policy.exclusive === true,
      };
    }

    function inputConstraints(element) {
      return {
        placeholder: element.placeholder || '',
        autocomplete: element.autocomplete || '',
        pattern: element.getAttribute('pattern') || '',
        maxLength: element.maxLength > -1 ? element.maxLength : null,
      };
    }

    function currentValueState(element, optionValue) {
      return {
        checked: Boolean(element.checked),
        value: rawCurrentValue(element),
        optionValue: isChoiceControl(element) ? optionValue : '',
        options: element.tagName === 'SELECT' ? selectOptions(element) : [],
      };
    }

    // The description is the scan's wire format; keys keep their published order.
    function fieldDescription(element, { fieldKey, groupKey, optionLabel, question, policy, optionValue }) {
      return {
        fieldKey,
        groupKey,
        ...controlIdentity(element, policy),
        label: optionLabel,
        optionLabel,
        question,
        ...policyAnnotations(policy),
        ...inputConstraints(element),
        required: requiredField(element, optionLabel, question, policy),
        disabled: element.disabled,
        visible: true,
        ...currentValueState(element, optionValue),
        sensitive: policy.sensitive === true || looksSensitive(element, `${question} ${optionLabel}`),
      };
    }

    // Describe-field pipeline: skip unavailable or out-of-scope controls, resolve
    // label and question, merge the site policy, then derive group and option keys.
    function describeField(element, fieldKey, elements) {
      const optionLabel = labelFor(element);
      if (shouldIgnore(element, optionLabel)) return null;
      const inferredQuestion = isChoiceControl(element) ? questionText(element, optionLabel) : '';
      const policy = sitePolicyFor(element, optionLabel, inferredQuestion);
      if (policy.ignore) return null;
      const question = cleanText(policy.question) || inferredQuestion;
      const groupKey = groupKeyFor(policy, element, question, elements);
      const optionValue = optionValueFor(policy, element);
      return {
        element,
        optionValue,
        description: fieldDescription(element, { fieldKey, groupKey, optionLabel, question, policy, optionValue }),
      };
    }

    function registerField({ element, optionValue, description }) {
      const { fieldKey, groupKey, optionLabel, exclusive } = description;
      fieldMap.set(fieldKey, element);
      if (!groupKey) return;
      const members = groupMap.get(groupKey) || [];
      members.push({ element, fieldKey, optionLabel, optionValue, exclusive });
      groupMap.set(groupKey, members);
    }

    function scanFields() {
      const scanNumber = nextScanNumber();
      fieldMap.clear();
      groupMap.clear();
      const elements = [...document.querySelectorAll('input, select, textarea')];
      const descriptions = [];

      elements.forEach((element, index) => {
        const field = describeField(element, `field:${scanNumber}:${index}`, elements);
        if (!field) return;
        registerField(field);
        descriptions.push(field.description);
      });

      return descriptions;
    }

    return { scanFields, rawCurrentValue };
  }

  const api = { create };
  root.NavaPageFieldInventory = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
