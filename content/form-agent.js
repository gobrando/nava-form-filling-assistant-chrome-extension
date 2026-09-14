(function installPageAgent() {
  'use strict';

  if (globalThis.__NAVA_FORM_FILLER_AGENT__) return;
  globalThis.__NAVA_FORM_FILLER_AGENT__ = true;

  const engine = globalThis.NavaFormEngine;
  const fieldMap = new Map();
  const groupMap = new Map();
  let scanNumber = 0;

  const PLAYBOOKS = {
    'benefitscal.com': {
      name: 'California benefits application',
      probes: ['#primarylang', '#addressLine1', '#zip5', '#birthDate_primary_input', '#ssn'],
      note: 'Bundled playbook; pages after the work-program details remain unconfirmed.',
    },
    'riversideihss.org': {
      name: 'Riverside County IHSS application',
      probes: ['#firstNameTxt', '#ssnTxt', '#btnSubmit'],
      note: 'Bundled playbook with confirmed mask, gate, and submit-check behavior.',
    },
    'www.ruhealth.org': {
      name: 'Riverside University Health System WIC application',
      probes: ['#edit-name', '#edit-please-choose-the-wic-clinic-closest-to-you', '#edit-submit'],
      note: 'Bundled playbook with confirmed inline-form and CAPTCHA behavior.',
    },
  };

  function visible(element) {
    if (!element || element.type === 'hidden') return false;
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) !== 0 && rect.width > 0 && rect.height > 0;
  }

  function cleanText(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
  }

  function explicitLabel(element) {
    if (element.id) {
      const label = document.querySelector(`label[for="${CSS.escape(element.id)}"]`);
      if (label) return cleanText(label.textContent);
    }
    const wrapped = element.closest('label');
    if (wrapped) return cleanText(wrapped.textContent);
    return '';
  }

  function labelledByText(element) {
    const ids = cleanText(element.getAttribute('aria-labelledby')).split(' ').filter(Boolean);
    return cleanText(ids.map((id) => document.getElementById(id)?.textContent || '').join(' '));
  }

  function questionText(element, optionLabel) {
    const group = element.closest('fieldset, [role="radiogroup"], [role="group"]');
    if (group) {
      const heading = group.querySelector(':scope > legend, :scope > [role="heading"], :scope > .question, :scope > .form-label, :scope > label');
      const text = cleanText(heading?.textContent);
      if (text && text !== optionLabel) return text;
    }

    let parent = element.parentElement;
    for (let depth = 0; parent && depth < 4; depth += 1, parent = parent.parentElement) {
      const heading = parent.querySelector(':scope > legend, :scope > h1, :scope > h2, :scope > h3, :scope > h4, :scope > .question, :scope > .form-label');
      const text = cleanText(heading?.textContent);
      if (text && text !== optionLabel && text.length < 240) return text;
    }
    return '';
  }

  function labelFor(element) {
    const explicit = explicitLabel(element);
    const aria = cleanText(element.getAttribute('aria-label'));
    const by = labelledByText(element);
    const placeholder = cleanText(element.getAttribute('placeholder'));
    return explicit || aria || by || placeholder || cleanText(element.name) || cleanText(element.id) || 'Unlabeled field';
  }

  function looksSensitive(element, label) {
    const signal = engine.normalize(`${label} ${element.name || ''} ${element.id || ''} ${element.autocomplete || ''}`);
    return /social security|\bssn\b|employer identification|\bein\b|tax id|bank account|routing number|credit card|card number|passport|immigration/.test(signal)
      || element.type === 'password';
  }

  function shouldIgnore(element, label) {
    const type = String(element.type || '').toLowerCase();
    const autocomplete = String(element.autocomplete || '').toLowerCase();
    const signal = engine.normalize(`${label} ${element.name || ''} ${element.id || ''} ${autocomplete}`);
    if (!visible(element)) return true;
    if (['hidden', 'submit', 'button', 'reset', 'image', 'file', 'search'].includes(type)) return true;
    if (/current-password|new-password|one-time-code|cc-number|cc-csc|cc-exp/.test(autocomplete)) return true;
    if (type === 'password' && !/social security|\bssn\b|date of birth|birth date|birthdate/.test(signal)) return true;
    if (/credit card|card number|security code|\bcvv\b|routing number|bank account|payment account/.test(signal)) return true;
    if (/leave this field blank|do not fill|honeypot|website url|site search|search this site/.test(signal)) return true;
    if (element.closest('[role="search"], .search-form, .site-search, .g-recaptcha')) return true;
    return false;
  }

  function requiredField(element, label, question) {
    return element.required
      || element.getAttribute('aria-required') === 'true'
      || /(^|\s)required(\s|$)/i.test(`${label} ${question}`)
      || /\*$/.test(label.trim());
  }

  function selectOptions(element) {
    return [...element.options]
      .filter((option) => option.value !== '' && !option.disabled)
      .map((option) => ({ value: option.value, label: cleanText(option.textContent) }));
  }

  function rawCurrentValue(element) {
    if (element.type === 'checkbox' || element.type === 'radio') return element.checked ? element.value || 'yes' : '';
    return element.value || '';
  }

  function scanFields() {
    scanNumber += 1;
    fieldMap.clear();
    groupMap.clear();
    const elements = [...document.querySelectorAll('input, select, textarea')];
    const descriptions = [];

    elements.forEach((element, index) => {
      const optionLabel = labelFor(element);
      if (shouldIgnore(element, optionLabel)) return;
      const question = ['radio', 'checkbox'].includes(element.type)
        ? questionText(element, optionLabel)
        : '';
      const fieldKey = `field:${scanNumber}:${index}`;
      const sameTypeCount = elements.filter((candidate) =>
        candidate !== element
        && candidate.type === element.type
        && ((element.name && candidate.name === element.name)
          || (!element.name && question && questionText(candidate, labelFor(candidate)) === question)),
      ).length;
      const groupKey = ['radio', 'checkbox'].includes(element.type) && (element.name || sameTypeCount > 0)
        ? `group:${element.type}:${element.name || engine.compact(question)}`
        : '';

      fieldMap.set(fieldKey, element);
      if (groupKey) {
        const members = groupMap.get(groupKey) || [];
        members.push({ element, fieldKey, optionLabel });
        groupMap.set(groupKey, members);
      }

      descriptions.push({
        fieldKey,
        groupKey,
        tag: element.tagName.toLowerCase(),
        type: element.tagName === 'SELECT' ? 'select-one' : String(element.type || 'text').toLowerCase(),
        id: element.id || '',
        name: element.name || '',
        label: optionLabel,
        optionLabel,
        question,
        placeholder: element.placeholder || '',
        autocomplete: element.autocomplete || '',
        maxLength: element.maxLength > -1 ? element.maxLength : null,
        required: requiredField(element, optionLabel, question),
        disabled: element.disabled,
        visible: true,
        checked: Boolean(element.checked),
        value: rawCurrentValue(element),
        options: element.tagName === 'SELECT' ? selectOptions(element) : [],
        sensitive: looksSensitive(element, `${question} ${optionLabel}`),
      });
    });

    return descriptions;
  }

  function playbookStatus() {
    const hostname = location.hostname.toLowerCase();
    const playbook = PLAYBOOKS[hostname];
    if (!playbook) {
      return {
        status: 'cold',
        name: hostname || 'This site',
        note: 'No bundled playbook. The extension is using a fresh field scan.',
      };
    }
    const matches = playbook.probes.filter((selector) => document.querySelector(selector)).length;
    return {
      status: matches > 0 ? 'fresh' : 'partial',
      name: playbook.name,
      note: matches > 0
        ? `${playbook.note} A known field was found on this page.`
        : `${playbook.note} No freshness field appears on this page, so every write will rely on the live scan and readback.`,
    };
  }

  function botCheckStatus() {
    const token = document.querySelector('#g-recaptcha-response, [name="cf-turnstile-response"]');
    if (!token) return { present: false, complete: false };
    return { present: true, complete: String(token.value || '').length > 100 };
  }

  function submitGateStatus() {
    const controls = [...document.querySelectorAll('button, input[type="submit"], [role="button"]')]
      .filter(visible)
      .map((element) => ({
        text: cleanText(element.textContent || element.value || element.getAttribute('aria-label')),
        enabled: !element.disabled && element.getAttribute('aria-disabled') !== 'true',
      }));
    const submit = controls.find((control) => /submit|send application|finish application|complete application/i.test(control.text));
    const bot = botCheckStatus();
    return {
      found: Boolean(submit),
      text: submit?.text || '',
      enabled: Boolean(submit?.enabled),
      botCheckPresent: bot.present,
      botCheckComplete: bot.complete,
      blockedReason: bot.present && !bot.complete
        ? 'A human must complete the bot check before submission.'
        : '',
    };
  }

  function nativeValueSetter(element) {
    const prototype = element.tagName === 'TEXTAREA'
      ? HTMLTextAreaElement.prototype
      : element.tagName === 'SELECT'
        ? HTMLSelectElement.prototype
        : HTMLInputElement.prototype;
    return Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
  }

  function dispatchValueEvents(element) {
    element.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    element.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
  }

  function setTextValue(element, value) {
    const setter = nativeValueSetter(element);
    if (setter) setter.call(element, value);
    else element.value = value;
    dispatchValueEvents(element);
  }

  async function incrementalWrite(element, value) {
    const digitsOnly = /date|tel|phone|ssn|social security/i.test(`${element.type} ${labelFor(element)} ${element.id}`);
    const characters = [...(digitsOnly ? String(value).replace(/\D/g, '') : String(value))];
    element.focus();
    setTextValue(element, '');
    for (const character of characters) {
      element.dispatchEvent(new KeyboardEvent('keydown', { key: character, bubbles: true, composed: true }));
      element.dispatchEvent(new InputEvent('beforeinput', { data: character, inputType: 'insertText', bubbles: true, composed: true }));
      const start = Number.isFinite(element.selectionStart) ? element.selectionStart : element.value.length;
      if (typeof element.setRangeText === 'function') {
        element.setRangeText(character, start, element.selectionEnd ?? start, 'end');
      } else {
        setTextValue(element, `${element.value}${character}`);
      }
      element.dispatchEvent(new InputEvent('input', { data: character, inputType: 'insertText', bubbles: true, composed: true }));
      element.dispatchEvent(new KeyboardEvent('keyup', { key: character, bubbles: true, composed: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    element.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
    element.blur();
  }

  function optionMatch(optionLabel, optionValue, wanted) {
    const target = engine.normalize(wanted);
    const label = engine.normalize(optionLabel);
    const value = engine.normalize(optionValue);
    if (target === label || target === value) return true;
    if (target === 'yes') return /^(yes|y|true|1)$/.test(label) || /^(yes|y|true|1)$/.test(value);
    if (target === 'no') return /^(no|n|false|0)$/.test(label) || /^(no|n|false|0)$/.test(value);
    return label.includes(target) || target.includes(label);
  }

  function setChecked(element, checked) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'checked')?.set;
    if (setter) setter.call(element, checked);
    else element.checked = checked;
    dispatchValueEvents(element);
  }

  async function writeAssignment(assignment) {
    const grouped = groupMap.get(assignment.fieldKey);
    const entry = grouped?.find(({ element, optionLabel }) => optionMatch(optionLabel, element.value, assignment.value));
    const element = entry?.element || fieldMap.get(assignment.fieldKey);
    if (!element) return { ...assignment, status: 'blocked', reason: 'The field changed after the page scan. Scan the page again.' };
    if (!visible(element)) return { ...assignment, status: 'blocked', reason: 'The field is hidden by an earlier question.' };
    if (element.disabled) return { ...assignment, status: 'blocked', reason: 'The field is disabled by an earlier question.' };
    if (Number(element.maxLength) > 0 && String(assignment.value).length > element.maxLength) {
      return { ...assignment, status: 'blocked', reason: `The value is longer than the form allows (${element.maxLength} characters).` };
    }

    if (grouped) {
      if (!entry) return { ...assignment, status: 'blocked', reason: 'The answer does not match one of the choices on the form.' };
      if (element.type === 'radio') {
        grouped.forEach((member) => setChecked(member.element, member.element === element));
      } else {
        setChecked(element, true);
      }
    } else if (element.type === 'checkbox') {
      setChecked(element, /^(yes|true|1|on)$/i.test(String(assignment.value)));
    } else if (element.tagName === 'SELECT') {
      const option = [...element.options].find((candidate) => optionMatch(candidate.textContent, candidate.value, assignment.value));
      if (!option) return { ...assignment, status: 'blocked', reason: 'The answer does not match one of the choices on the form.' };
      setTextValue(element, option.value);
    } else {
      setTextValue(element, String(assignment.value));
    }

    let actual = grouped
      ? grouped.find((member) => member.element.checked)?.element.value || ''
      : rawCurrentValue(element);
    let verified = grouped
      ? Boolean(grouped.find((member) => member.element.checked && optionMatch(member.optionLabel, member.element.value, assignment.value)))
      : engine.valuesEquivalent(assignment.value, actual, { type: element.type, label: labelFor(element) });

    if (!verified && !grouped && element.tagName !== 'SELECT' && !['checkbox', 'radio'].includes(element.type)) {
      await incrementalWrite(element, assignment.value);
      actual = rawCurrentValue(element);
      verified = engine.valuesEquivalent(assignment.value, actual, { type: element.type, label: labelFor(element) });
    }

    return {
      ...assignment,
      status: verified ? 'verified' : 'blocked',
      actual,
      reason: verified ? '' : 'The form did not keep the value after two verified write methods. Enter this field directly.',
    };
  }

  function maskValue(value, sensitive) {
    if (!sensitive) return String(value ?? '');
    const text = String(value ?? '');
    const digits = text.replace(/\D/g, '');
    return digits.length >= 4 ? `••••${digits.slice(-4)}` : '••••';
  }

  async function fill(assignments) {
    const results = [];
    for (const assignment of assignments || []) {
      results.push(await writeAssignment(assignment));
    }
    const provenance = results.map((result) => ({
      fieldKey: result.fieldKey,
      label: result.label,
      value: result.status === 'verified' ? maskValue(result.actual || result.value, result.sensitive) : '(empty)',
      source: result.status === 'verified' ? result.source : 'empty',
      detail: result.status === 'verified' ? result.detail : result.reason,
      status: result.status,
    }));
    return {
      results,
      provenance,
      verifiedCount: results.filter((result) => result.status === 'verified').length,
      blockedCount: results.filter((result) => result.status === 'blocked').length,
      submitGate: submitGateStatus(),
    };
  }

  async function handleMessage(message) {
    if (message?.type === 'NAVA_PING') return { ok: true };
    if (message?.type === 'NAVA_SCAN') {
      const fields = scanFields();
      return {
        ok: true,
        page: {
          title: document.title,
          url: location.href,
          domain: location.hostname,
        },
        playbook: playbookStatus(),
        analysis: engine.buildAnalysis(fields, message.participant || {}),
        submitGate: submitGateStatus(),
      };
    }
    if (message?.type === 'NAVA_FILL') {
      return { ok: true, ...(await fill(message.assignments || [])) };
    }
    if (message?.type === 'NAVA_SUBMIT_STATUS') {
      return { ok: true, submitGate: submitGateStatus() };
    }
    return { ok: false, error: 'Unknown message.' };
  }

  globalThis.NavaPageAgentTestApi = {
    scan: (participant) => handleMessage({ type: 'NAVA_SCAN', participant }),
    fill: (assignments) => handleMessage({ type: 'NAVA_FILL', assignments }),
  };

  if (globalThis.chrome?.runtime?.onMessage) {
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (!String(message?.type || '').startsWith('NAVA_')) return false;
      handleMessage(message)
        .then(sendResponse)
        .catch((error) => sendResponse({ ok: false, error: error.message }));
      return true;
    });
  }
})();
