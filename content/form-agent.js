(function installPageAgent() {
  'use strict';

  const PAGE_AGENT_VERSION = 6;
  if (globalThis.__NAVA_FORM_FILLER_AGENT__?.version === PAGE_AGENT_VERSION) return;
  globalThis.__NAVA_FORM_FILLER_AGENT__ = { version: PAGE_AGENT_VERSION };

  const engine = globalThis.NavaFormEngine;
  const fieldMap = new Map();
  const groupMap = new Map();
  let scanNumber = 0;
  let fillGeneration = 0;

  const PLAYBOOKS = {
    'benefitscal.com': {
      name: 'California benefits application',
      probes: ['#primarylang', '#addressLine1', '#zip5', '#birthDate_primary_input', '#ssn'],
      note: 'Bundled playbook; automatic continuation is limited to exact Begin, Next, and Continue controls.',
      autoAdvance: true,
      safeAdvanceSelectors: ['button[name="common_continue"]'],
      safeAdvanceRules: [
        { labels: ['begin'], path: '/ApplyForBenefits/begin/ABOVR' },
        {
          labels: [
            'start your information',
            'start people',
            'start household',
            'start income',
            'start expenses',
            'start assets',
            'start other situations',
            'start document upload',
          ],
          path: '/ApplyForBenefits/ABNAV',
        },
      ],
    },
    'riversideihss.org': {
      name: 'Riverside County IHSS application',
      probes: ['#firstNameTxt', '#ssnTxt', '#btnSubmit'],
      note: 'Bundled playbook with confirmed mask, gate, and submit-check behavior.',
      autoAdvance: true,
    },
    'ruhealth.org': {
      name: 'Riverside University Health System WIC application',
      probes: ['#edit-name', '#edit-please-choose-the-wic-clinic-closest-to-you', '#edit-submit'],
      note: 'Bundled playbook with confirmed inline-form and CAPTCHA behavior.',
      autoAdvance: false,
    },
  };

  const SAFE_ADVANCE_LABELS = new Set([
    'next',
    'next step',
    'continue',
    'continue to next step',
    'save and continue',
    'save continue',
  ]);
  const BENEFITSCAL_ABNAV_START_HEADINGS = new Set([
    'your information',
    'people',
    'household details',
    'income',
    'expenses',
    'assets',
    'other situations',
    'document upload',
  ]);
  const FINAL_ACTION_PATTERN = /\b(submit|finish|complete|certify|attest|sign|send|file|apply)\b/i;
  const FINAL_PAGE_PATTERN = /^(review (?:and|&) submit|review and submit your application|final review|ready to submit|submit your application|certification|attestation|signature|declaration)\b/i;
  const PRODUCTION_SETTLE_MS = 160;
  const PRESENTATION_FIELD_MS = 450;
  const DOM_QUIET_MS = 500;
  const MAX_SETTLE_MS = 2500;
  const PAGE_VALIDATION_MIN_MS = 1800;
  const PAGE_VALIDATION_MAX_MS = 4000;
  const MAX_FILL_ASSIGNMENTS = 80;
  const PAGE_TOOL_DEFINITIONS = Object.freeze([
    {
      name: 'inspect_application_page',
      description: 'Read the visible application controls, safe navigation state, and final-action boundary without changing the page.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true, untrustedContentHint: true, consequentialHint: false },
      command: 'NAVA_SCAN',
    },
    {
      name: 'fill_reviewed_fields',
      description: 'Write a locally validated batch of field-key/value assignments and read every field back. This tool cannot submit.',
      inputSchema: {
        type: 'object',
        properties: {
          assignments: {
            type: 'array',
            maxItems: MAX_FILL_ASSIGNMENTS,
            items: {
              type: 'object',
              properties: {
                fieldKey: { type: 'string' },
                label: { type: 'string' },
                value: { type: ['string', 'number', 'boolean'] },
                source: { type: 'string', enum: ['record', 'changed', 'user'] },
                sensitive: { type: 'boolean' },
              },
              required: ['fieldKey', 'value'],
              additionalProperties: false,
            },
          },
        },
        required: ['assignments'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, untrustedContentHint: false, consequentialHint: false },
      command: 'NAVA_FILL',
    },
    {
      name: 'continue_application_step',
      description: 'Activate only the exact allowlisted continuation control for the current approved application route. Final actions are excluded.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: false, untrustedContentHint: false, consequentialHint: false },
      command: 'NAVA_ADVANCE',
    },
  ]);

  function delay(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
  }

  function trustedDemoFixture() {
    const trustedOrigins = new Set(['http://127.0.0.1:4173', 'http://localhost:4173']);
    const trustedPaths = new Set(['/demo/multi-page.html', '/demo/extensive-application.html']);
    return document.documentElement.dataset.navaDemoFlow === 'true'
      && trustedOrigins.has(location.origin)
      && trustedPaths.has(location.pathname);
  }

  function pathMatchesPrefix(path, prefix) {
    if (!path || !prefix) return false;
    if (prefix.endsWith('/')) return path.startsWith(prefix);
    return path === prefix || path.startsWith(`${prefix}/`);
  }

  function normalizeSearch(value) {
    const raw = String(value || '').trim().replace(/^\?/, '');
    if (!raw) return '';
    const params = new URLSearchParams(raw);
    params.sort();
    const normalized = params.toString();
    return normalized ? `?${normalized}` : '';
  }

  function normalizeHash(value) {
    const raw = String(value || '').trim();
    if (!raw || raw === '#') return '';
    return raw.startsWith('#') ? raw : `#${raw}`;
  }

  function routeAuthorized(policy) {
    if (!policy || typeof policy !== 'object') return false;
    const origins = Array.isArray(policy.origins) ? policy.origins : [];
    const exactPaths = Array.isArray(policy.exactPaths) ? policy.exactPaths : [];
    const pathPrefixes = Array.isArray(policy.pathPrefixes) ? policy.pathPrefixes : [];
    const originAllowed = origins.includes(location.origin);
    const expectedPathAllowed = !policy.expectedPath || policy.expectedPath === location.pathname;
    const expectedSearchAllowed = !Object.prototype.hasOwnProperty.call(policy, 'expectedSearch')
      || normalizeSearch(policy.expectedSearch) === normalizeSearch(location.search);
    const expectedHashAllowed = !Object.prototype.hasOwnProperty.call(policy, 'expectedHash')
      || normalizeHash(policy.expectedHash) === normalizeHash(location.hash);
    const pathAllowed = exactPaths.includes(location.pathname)
      || pathPrefixes.some((prefix) => pathMatchesPrefix(location.pathname, String(prefix)));
    return originAllowed && expectedPathAllowed && expectedSearchAllowed && expectedHashAllowed && pathAllowed;
  }

  function presentationMode() {
    return trustedDemoFixture();
  }

  function nextAnimationFrame() {
    return new Promise((resolve) => requestAnimationFrame(() => resolve()));
  }

  function validationProblem(element) {
    if (!element) return '';
    if (element.getAttribute?.('aria-invalid') === 'true') return 'The form marked this value invalid.';
    if (typeof element.checkValidity === 'function' && !element.checkValidity()) {
      return cleanText(element.validationMessage) || 'The value does not satisfy the form’s validation rules.';
    }
    const describedBy = String(element.getAttribute?.('aria-describedby') || '').split(/\s+/).filter(Boolean);
    const describedError = describedBy
      .map((id) => document.getElementById(id))
      .filter((node) => {
        if (!node || !visible(node)) return false;
        const signal = `${node.getAttribute?.('role') || ''} ${node.getAttribute?.('aria-live') || ''} ${node.id || ''} ${node.className || ''}`;
        return /\b(alert|assertive|error|invalid|validation|feedback|danger)\b/i.test(signal);
      })
      .map((node) => cleanText(node.textContent))
      .find(Boolean);
    return describedError || '';
  }

  async function waitForStableRead(element, readValue) {
    await nextAnimationFrame();
    await nextAnimationFrame();
    const startedAt = Date.now();
    let lastChangedAt = startedAt;
    let lastDomChangeAt = startedAt;
    let observed = String(readValue() ?? '');
    const minimumWait = presentationMode() ? PRESENTATION_FIELD_MS : PRODUCTION_SETTLE_MS;
    const observer = typeof MutationObserver === 'function' && document.documentElement
      ? new MutationObserver(() => { lastDomChangeAt = Date.now(); })
      : null;
    try {
      observer?.observe(element.closest?.('form') || document.documentElement, {
        subtree: true,
        childList: true,
        characterData: true,
        attributes: true,
        attributeFilter: ['aria-invalid', 'aria-describedby', 'class', 'hidden'],
      });
      while (Date.now() - startedAt < MAX_SETTLE_MS) {
        await delay(80);
        const next = String(readValue() ?? '');
        if (next !== observed) {
          observed = next;
          lastChangedAt = Date.now();
        }
        const elapsed = Date.now() - startedAt;
        const valueQuiet = Date.now() - lastChangedAt >= DOM_QUIET_MS;
        const domQuiet = Date.now() - lastDomChangeAt >= DOM_QUIET_MS;
        if (elapsed >= minimumWait && valueQuiet && domQuiet) {
          return { value: observed, settled: true, problem: validationProblem(element) };
        }
      }
      return { value: observed, settled: false, problem: validationProblem(element) || 'The page did not finish validating this value.' };
    } finally {
      observer?.disconnect();
    }
  }

  function visibleValidationBusyIndicator() {
    return [...document.querySelectorAll('[aria-busy="true"], [role="progressbar"], .loading, .spinner, .validating')]
      .some(visible);
  }

  async function waitForPageValidation(generation) {
    const startedAt = Date.now();
    let lastDomChangeAt = startedAt;
    const observer = typeof MutationObserver === 'function' && document.documentElement
      ? new MutationObserver(() => { lastDomChangeAt = Date.now(); })
      : null;
    try {
      observer?.observe(document.documentElement, {
        subtree: true,
        childList: true,
        characterData: true,
        attributes: true,
        attributeFilter: ['aria-busy', 'aria-invalid', 'aria-describedby', 'class', 'hidden', 'value'],
      });
      while (Date.now() - startedAt < PAGE_VALIDATION_MAX_MS) {
        await delay(100);
        if (generation !== fillGeneration) return { settled: false, cancelled: true };
        const elapsed = Date.now() - startedAt;
        if (elapsed >= PAGE_VALIDATION_MIN_MS
          && Date.now() - lastDomChangeAt >= DOM_QUIET_MS
          && !visibleValidationBusyIndicator()) {
          return { settled: true, cancelled: false };
        }
      }
      return { settled: false, cancelled: false };
    } finally {
      observer?.disconnect();
    }
  }

  function visible(element) {
    if (!element || element.type === 'hidden') return false;
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) !== 0 && rect.width > 0 && rect.height > 0;
  }

  function cleanText(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
  }

  function select2Container(element) {
    if (element?.tagName !== 'SELECT') return null;
    const sibling = element.nextElementSibling;
    if (sibling?.matches?.('.select2, .select2-container')) return sibling;
    const parent = element.parentElement;
    if (!parent?.querySelector) return null;
    try {
      return parent.querySelector('.select2-container');
    } catch {
      return null;
    }
  }

  function fieldVisible(element) {
    if (visible(element)) return true;
    const container = select2Container(element);
    return Boolean(container && visible(container));
  }

  function select2SelectionMatches(element) {
    const container = select2Container(element);
    if (!container) return true;
    const rendered = cleanText(container.querySelector?.('.select2-selection__rendered')?.textContent);
    const selected = [...(element.options || [])].find((option) => String(option.value) === String(element.value));
    return Boolean(rendered && selected && engine.normalize(rendered) === engine.normalize(cleanText(selected.textContent)));
  }

  function associatedLabel(element) {
    if (element.id) {
      const label = document.querySelector(`label[for="${CSS.escape(element.id)}"]`);
      if (label) return label;
    }
    return null;
  }

  function explicitLabel(element) {
    const associated = associatedLabel(element);
    if (associated) return cleanText(associated.textContent);
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

  const IGNORED_INPUT_TYPES = new Set(['hidden', 'submit', 'button', 'reset', 'image', 'file', 'search']);

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
    return globalThis.NavaSiteAdapters?.fieldPolicy?.(location.hostname, location.pathname, {
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
    scanNumber += 1;
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

  function playbookStatus() {
    const hostname = location.hostname.toLowerCase();
    const playbook = playbookForHost(hostname);
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

  function playbookForHost(hostname = location.hostname.toLowerCase()) {
    return Object.entries(PLAYBOOKS)
      .find(([domain]) => hostname === domain || hostname.endsWith(`.${domain}`))?.[1];
  }

  function botCheckStatus() {
    const token = document.querySelector(
      '#g-recaptcha-response, [name="g-recaptcha-response"], [name="h-captcha-response"], [name="cf-turnstile-response"]',
    );
    const widget = document.querySelector(
      '.g-recaptcha, .h-captcha, [data-sitekey], iframe[src*="recaptcha"], iframe[src*="hcaptcha"], iframe[src*="challenges.cloudflare.com"]',
    );
    const value = String(token?.value || '').trim();
    return { present: Boolean(token || widget), complete: value.length > 20 };
  }

  function oneTimeCodeStatus() {
    const input = [...document.querySelectorAll('input')].filter(visible).find((element) => {
      const signal = `${element.autocomplete || ''} ${element.name || ''} ${element.id || ''} ${labelFor(element)}`;
      return /one-time-code|\botp\b|verification code|security code|passcode/i.test(signal);
    });
    return { present: Boolean(input), complete: Boolean(String(input?.value || '').trim()) };
  }

  function submitGateStatus() {
    const controls = [...document.querySelectorAll('button, input[type="submit"], input[type="button"], [role="button"]')]
      .filter(visible)
      .map((element) => ({
        text: cleanText(element.textContent || element.value || element.getAttribute('aria-label')),
        enabled: !element.disabled && element.getAttribute('aria-disabled') !== 'true',
      }));
    const submit = controls.find((control) => /submit|send application|finish application|complete application/i.test(control.text));
    const bot = botCheckStatus();
    const oneTimeCode = oneTimeCodeStatus();
    return {
      found: Boolean(submit),
      text: submit?.text || '',
      enabled: Boolean(submit?.enabled),
      botCheckPresent: bot.present,
      botCheckComplete: bot.complete,
      oneTimeCodePresent: oneTimeCode.present,
      oneTimeCodeComplete: oneTimeCode.complete,
      blockedReason: oneTimeCode.present && !oneTimeCode.complete
        ? 'A human must enter the one-time code before the assistant can continue.'
        : bot.present && !bot.complete
        ? 'A human must complete the bot check before submission.'
        : '',
    };
  }

  function pageSignature() {
    const heading = [...document.querySelectorAll('h1, h2, [role="heading"]')]
      .filter(visible)
      .map((element) => cleanText(element.textContent))
      .find(Boolean) || document.title;
    const fieldSignal = [...document.querySelectorAll('input, select, textarea')]
      .filter(fieldVisible)
      .slice(0, 30)
      .map((element) => `${element.tagName}:${element.type || ''}:${element.name || element.id || labelFor(element)}`)
      .join('|');
    const interactionRoot = document.querySelector('main, [role="main"]') || document;
    const controlSignal = [...interactionRoot.querySelectorAll('button, input[type="submit"], input[type="button"], a[href], [role="button"]')]
      .filter(visible)
      .slice(0, 30)
      .map((element) => `${isControlEnabled(element) ? 'enabled' : 'disabled'}:${engine.normalize(navigationControlText(element))}`)
      .join('|');
    const source = `${location.href}|${heading}|${fieldSignal}|${controlSignal}`;
    let hash = 2166136261;
    for (let index = 0; index < source.length; index += 1) {
      hash ^= source.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return `${location.pathname}:${(hash >>> 0).toString(36)}`;
  }

  function navigationControlText(element) {
    return cleanText(
      element.getAttribute('aria-label')
      || labelledByText(element)
      || explicitLabel(element)
      || element.textContent
      || element.value
      || element.getAttribute('title'),
    );
  }

  function isControlEnabled(element) {
    return !element.disabled && element.getAttribute('aria-disabled') !== 'true';
  }

  function isSafeAdvanceText(text) {
    return SAFE_ADVANCE_LABELS.has(engine.normalize(text).replace(/\band\b/g, '').replace(/\s+/g, ' ').trim())
      || SAFE_ADVANCE_LABELS.has(engine.normalize(text));
  }

  function matchesSafeSelector(element, selectors) {
    return Boolean(element && Array.isArray(selectors) && selectors.some((selector) => {
      try {
        return element.matches(String(selector));
      } catch {
        return false;
      }
    }));
  }

  function safeAdvanceRuleMatches(element, text, rule) {
    if (!rule || typeof rule !== 'object') return false;
    const normalized = engine.normalize(text);
    const pathMatches = location.pathname.toLowerCase() === String(rule.path || '').toLowerCase();
    const searchMatches = !Object.prototype.hasOwnProperty.call(rule, 'search')
      || normalizeSearch(rule.search) === normalizeSearch(location.search);
    const hashMatches = !Object.prototype.hasOwnProperty.call(rule, 'hash')
      || normalizeHash(rule.hash) === normalizeHash(location.hash);
    const labelMatches = Array.isArray(rule.labels)
      && rule.labels.some((label) => engine.normalize(label) === normalized);
    const selectorMatches = matchesSafeSelector(element, rule.selectors);
    return pathMatches && searchMatches && hashMatches && (labelMatches || selectorMatches);
  }

  function nearestApplicationCardHeading(element) {
    const interactionRoot = document.querySelector('main, [role="main"]');
    let ancestor = element?.parentElement || null;
    for (let depth = 0; ancestor && depth < 12; depth += 1, ancestor = ancestor.parentElement) {
      if (ancestor === interactionRoot || ancestor === document.body || ancestor === document.documentElement) return '';
      let headings = [];
      try {
        headings = [...ancestor.querySelectorAll('h2, [role="heading"][aria-level="2"]')]
          .filter(visible);
      } catch {
        return '';
      }
      if (headings.length > 1) return '';
      if (headings.length === 1) return cleanText(headings[0].textContent);
    }
    return '';
  }

  function isBenefitsCalAbnavContextStart(element, text) {
    if (location.hostname.toLowerCase() !== 'benefitscal.com') return false;
    if (location.pathname !== '/ApplyForBenefits/ABNAV') return false;
    if (engine.normalize(text) !== 'start') return false;
    const heading = engine.normalize(nearestApplicationCardHeading(element));
    return BENEFITSCAL_ABNAV_START_HEADINGS.has(heading);
  }

  function isPlaybookAdvanceControl(element, text, playbook) {
    const normalized = engine.normalize(text);
    if (trustedDemoFixture()) return isSafeAdvanceText(text);
    return isBenefitsCalAbnavContextStart(element, text)
      || Boolean(playbook?.safeAdvanceLabels?.some((label) => engine.normalize(label) === normalized))
      || (matchesSafeSelector(element, playbook?.safeAdvanceSelectors) && isSafeAdvanceText(text))
      || Boolean(playbook?.safeAdvanceRules?.some((rule) => safeAdvanceRuleMatches(element, text, rule)));
  }

  function hasFinalPageSignal() {
    const primaryRoot = document.querySelector('main, [role="main"]') || document;
    const headings = [...primaryRoot.querySelectorAll('h1')]
      .filter(visible)
      .slice(0, 20)
      .map((element) => cleanText(element.textContent));
    if (headings.some((heading) => FINAL_PAGE_PATTERN.test(heading))) return true;
    const hostname = location.hostname.toLowerCase();
    const ihssAffirmation = (hostname === 'riversideihss.org' || hostname.endsWith('.riversideihss.org'))
      && location.pathname.startsWith('/IntakeApp')
      && [...primaryRoot.querySelectorAll('h5')]
        .filter(visible)
        .some((element) => /^section\s*9\s*[-–—:]\s*affirmation$/i.test(cleanText(element.textContent)));
    if (ihssAffirmation) return true;
    return [...document.querySelectorAll('input[type="checkbox"], input[type="radio"]')]
      .filter(visible)
      .some((element) => /certif|attest|affirm|under penalty|declare|signature|agree.*truth/i.test(
        `${labelFor(element)} ${questionText(element, labelFor(element))}`,
      ));
  }

  function visibleNavigationControls() {
    const interactionRoot = document.querySelector('main, [role="main"]') || document;
    return [...interactionRoot.querySelectorAll('button, input[type="submit"], input[type="button"], a[href], [role="button"]')]
      .filter((element) => visible(element) && isControlEnabled(element))
      .map((element) => ({ element, text: navigationControlText(element) }))
      .filter((item) => item.text);
  }

  // A control whose label reads as a final action is never a continuation.
  function navigationCandidates(playbook) {
    const controls = visibleNavigationControls();
    return {
      safeNext: controls.find((item) => isPlaybookAdvanceControl(item.element, item.text, playbook) && !FINAL_ACTION_PATTERN.test(item.text)),
      genericNext: controls.find((item) => isSafeAdvanceText(item.text) && !FINAL_ACTION_PATTERN.test(item.text)),
      finalAction: controls.find((item) => FINAL_ACTION_PATTERN.test(item.text)),
    };
  }

  function autoAdvanceAllowed(playbook) {
    return Boolean(playbook?.autoAdvance || trustedDemoFixture());
  }

  function humanCheckpointReason() {
    const oneTimeCode = oneTimeCodeStatus();
    if (oneTimeCode.present && !oneTimeCode.complete) return 'A human must enter the one-time code before the assistant can continue.';
    const bot = botCheckStatus();
    if (bot.present && !bot.complete) return 'A human must complete the bot check before the assistant can continue.';
    return '';
  }

  // Gate precedence: human checkpoint, final-page signal, authorized safe
  // continuation, visible final action, unauthorized continuation, nothing.
  function navigationDecision() {
    const playbook = playbookForHost();
    const { safeNext, genericNext, finalAction } = navigationCandidates(playbook);
    const signature = pageSignature();
    const stop = (kind, text, reason) => ({ element: null, gate: { kind, text, pageSignature: signature, reason } });

    const checkpoint = humanCheckpointReason();
    if (checkpoint) return stop('manual', '', checkpoint);
    if (hasFinalPageSignal()) {
      return stop('final_review', finalAction?.text || '', 'The application reached a certification, signature, or final review step. Submission stays with the caseworker.');
    }
    if (safeNext && autoAdvanceAllowed(playbook)) {
      return {
        element: safeNext.element,
        gate: { kind: 'next', text: safeNext.text, pageSignature: signature, reason: `A known safe “${safeNext.text}” control is ready.` },
      };
    }
    if (finalAction) {
      return stop('final_review', finalAction.text, `The next visible action is “${finalAction.text}”. The assistant will not activate it.`);
    }
    if (genericNext) {
      return stop('manual', genericNext.text, 'This continuation control is not authorized for the current production route. Continue on the page, then resume the assistant.');
    }
    return stop('none', '', 'No safe continuation control is visible.');
  }

  function navigationStatus() {
    return navigationDecision().gate;
  }

  function advance() {
    const decision = navigationDecision();
    if (decision.gate.kind !== 'next' || !decision.element) {
      return { advanced: false, navigationGate: decision.gate };
    }
    const beforeUrl = location.href;
    const beforeTitle = document.title;
    try {
      decision.element.scrollIntoView({ block: 'center', inline: 'center' });
    } catch {
      // Some form controls do not expose scrollIntoView in older browser contexts.
    }
    const mouseEvent = (type) => {
      try {
        decision.element.dispatchEvent(new MouseEvent(type, {
          bubbles: true,
          cancelable: true,
          composed: true,
          view: globalThis.window,
          button: 0,
          buttons: type === 'mousedown' ? 1 : 0,
        }));
      } catch {
        // HTMLElement.click below remains the standards-based fallback.
      }
    };
    mouseEvent('mouseover');
    mouseEvent('mousemove');
    mouseEvent('mousedown');
    decision.element.focus();
    mouseEvent('mouseup');
    decision.element.click();
    if (location.hostname.toLowerCase() === 'benefitscal.com'
      && location.pathname === '/ApplyForBenefits/begin/ABOVR'
      && engine.normalize(decision.gate.text) === 'begin') {
      const expectedOrigin = location.origin;
      const expectedPath = location.pathname;
      setTimeout(() => {
        if (location.origin === expectedOrigin
          && location.pathname === expectedPath
          && typeof location.assign === 'function') {
          location.assign('/ApplyForBenefits/ABHLT');
        }
      }, 3000);
    }
    return {
      advanced: true,
      beforeUrl,
      beforeTitle,
      navigationGate: decision.gate,
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
    const pattern = String(element.getAttribute?.('pattern') || '');
    const patternRequiresFormatting = /\\[()s-]|[() ]|\}\s*-\s*/.test(pattern);
    const digitsOnly = /date|tel|phone|ssn|social security/i.test(`${element.type} ${labelFor(element)} ${element.id}`)
      && !patternRequiresFormatting;
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
    const normalizedTarget = engine.normalize(wanted);
    const target = ['false', '0'].includes(normalizedTarget)
      ? 'no'
      : ['true', '1'].includes(normalizedTarget)
        ? 'yes'
        : normalizedTarget;
    const label = engine.normalize(optionLabel);
    const value = engine.normalize(optionValue);
    if (!target) return false;
    if (target === label || target === value) return true;
    if (target === 'yes') return /^(yes|y|true|1)$/.test(label) || /^(yes|y|true|1)$/.test(value);
    if (target === 'no') return /^(no|n|false|0)$/.test(label) || /^(no|n|false|0)$/.test(value);
    return Boolean(label)
      && (` ${label} `.includes(` ${target} `) || ` ${target} `.includes(` ${label} `));
  }

  function setChecked(element, checked) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'checked')?.set;
    if (setter) setter.call(element, checked);
    else element.checked = checked;
    dispatchValueEvents(element);
  }

  const CHECKED_ANSWER_PATTERN = /^(yes|true|1|on)$/i;
  const NO_MATCHING_CHOICE = 'The answer does not match one of the choices on the form.';

  function checkboxAnswer(value) {
    return CHECKED_ANSWER_PATTERN.test(String(value));
  }

  // The scanned control an assignment targets: the matching member of a choice
  // group, or the single field registered under the assignment's key.
  function assignmentTarget(fieldKey, value) {
    const grouped = groupMap.get(fieldKey);
    const entry = grouped?.find(({ optionLabel, optionValue }) => optionMatch(optionLabel, optionValue, value));
    return { grouped, entry, element: entry?.element || fieldMap.get(fieldKey) };
  }

  function writeBlocker(element, value) {
    if (!element) return 'The field changed after the page scan. Scan the page again.';
    if (!fieldVisible(element)) return 'The field is hidden by an earlier question.';
    if (element.disabled) return 'The field is disabled by an earlier question.';
    if (Number(element.maxLength) > 0 && String(value).length > element.maxLength) {
      return `The value is longer than the form allows (${element.maxLength} characters).`;
    }
    return '';
  }

  function captureOutline(element) {
    const { outline, outlineOffset } = element.style;
    return () => {
      element.style.outline = outline;
      element.style.outlineOffset = outlineOffset;
    };
  }

  async function spotlight(element) {
    element.scrollIntoView({ block: 'center', behavior: 'auto' });
    element.style.outline = '3px solid #b14092';
    element.style.outlineOffset = '3px';
    await nextAnimationFrame();
    await nextAnimationFrame();
  }

  // Writer strategies. Each write is synchronous, goes through the native
  // setters and input/change events, and returns a refusal reason or ''.

  // Radio groups and exclusive checkbox groups clear every other member; an
  // inclusive checkbox group only checks the chosen box.
  function writeChoiceGroup({ grouped, entry }) {
    if (!entry) return NO_MATCHING_CHOICE;
    if (entry.element.type === 'radio' || grouped.some((member) => member.exclusive)) {
      grouped.forEach((member) => setChecked(member.element, member.element === entry.element));
    } else {
      setChecked(entry.element, true);
    }
    return '';
  }

  function writeCheckbox({ element }, value) {
    setChecked(element, checkboxAnswer(value));
    return '';
  }

  function writeSelectOption({ element }, value) {
    const option = [...element.options].find((candidate) => optionMatch(candidate.textContent, candidate.value, value));
    if (!option) return NO_MATCHING_CHOICE;
    setTextValue(element, option.value);
    return '';
  }

  function writeNativeValue({ element }, value) {
    setTextValue(element, String(value));
    return '';
  }

  const VALUE_WRITERS = Object.freeze({
    choiceGroup: { write: writeChoiceGroup },
    checkbox: { write: writeCheckbox },
    // Native select (Select2 included): readback also confirms Select2's rendered selection.
    select: { write: writeSelectOption, confirmsRenderedSelection: true },
    // A radio outside any group keeps the native value write and is never typed into.
    plainValue: { write: writeNativeValue },
    // Text that a mask rejects as one value gets one keystroke-by-keystroke retry.
    text: { write: writeNativeValue, retry: incrementalWrite },
  });

  function writerFor({ element, grouped }) {
    if (grouped) return VALUE_WRITERS.choiceGroup;
    if (element.type === 'checkbox') return VALUE_WRITERS.checkbox;
    if (element.tagName === 'SELECT') return VALUE_WRITERS.select;
    return element.type === 'radio' ? VALUE_WRITERS.plainValue : VALUE_WRITERS.text;
  }

  // Readback shared by write verification and page-level revalidation: what a
  // control currently holds (read), what to report (report), and whether it
  // holds the requested answer (holds).
  const READBACKS = Object.freeze({
    group: {
      read: (_element, grouped) => grouped.find((member) => member.element.checked)?.optionValue || '',
      report: (_element, observed) => observed,
      holds: (_element, grouped, wanted) => grouped
        .some((member) => member.element.checked && optionMatch(member.optionLabel, member.optionValue, wanted)),
    },
    checkbox: {
      read: (element) => rawCurrentValue(element),
      report: (element) => (element.checked ? 'yes' : 'no'),
      holds: (element, _grouped, wanted) => element.checked === checkboxAnswer(wanted),
    },
    value: {
      read: (element) => rawCurrentValue(element),
      report: (_element, observed) => observed,
      holds: (element, _grouped, wanted, observed) => engine.valuesEquivalent(wanted, observed, { type: element.type, label: labelFor(element) }),
    },
  });

  function readbackFor(element, grouped) {
    if (grouped) return READBACKS.group;
    return element.type === 'checkbox' ? READBACKS.checkbox : READBACKS.value;
  }

  async function writeAssignment(assignment) {
    const target = assignmentTarget(assignment.fieldKey, assignment.value);
    const unavailable = writeBlocker(target.element, assignment.value);
    if (unavailable) return { ...assignment, status: 'blocked', reason: unavailable };

    const writer = writerFor(target);
    const restoreOutline = captureOutline(target.element);
    if (presentationMode()) await spotlight(target.element);
    const refusal = writer.write(target, assignment.value);
    if (refusal) {
      restoreOutline();
      return { ...assignment, status: 'blocked', reason: refusal };
    }
    if (typeof target.element.blur === 'function') target.element.blur();

    const outcome = await verifyWrite(writer, target, assignment.value);
    if (presentationMode()) restoreOutline();
    return {
      ...assignment,
      status: outcome.verified ? 'verified' : 'blocked',
      actual: outcome.actual,
      reason: outcome.verified ? '' : outcome.problem || 'The form did not keep the value after two verified write methods. Enter this field directly.',
    };
  }

  // Wait for the page to settle, then read the control back.
  async function settledReadBack(writer, { element, grouped }, wanted) {
    const readback = readbackFor(element, grouped);
    const stability = await waitForStableRead(element, () => readback.read(element, grouped));
    const holds = readback.holds(element, grouped, wanted, stability.value)
      && (!writer.confirmsRenderedSelection || select2SelectionMatches(element));
    return {
      verified: holds && stability.settled && !stability.problem,
      actual: readback.report(element, stability.value),
      problem: stability.problem,
    };
  }

  async function verifyWrite(writer, target, wanted) {
    const first = await settledReadBack(writer, target, wanted);
    if (first.verified || !writer.retry) return first;
    await writer.retry(target.element, wanted);
    return settledReadBack(writer, target, wanted);
  }

  function maskValue(value, sensitive) {
    if (!sensitive) return String(value ?? '');
    const text = String(value ?? '');
    const digits = text.replace(/\D/g, '');
    return digits.length >= 4 ? `••••${digits.slice(-4)}` : '••••';
  }

  function revalidationFailure(problem, pageSettled) {
    if (problem) return problem;
    return pageSettled
      ? 'The form changed this value during page validation. Enter it directly.'
      : 'The page did not finish validating all values.';
  }

  // After page-level validation, re-read every verified field once more.
  function revalidateAssignment(result, pageSettled) {
    if (result.status !== 'verified') return result;
    const { grouped, element: matched } = assignmentTarget(result.fieldKey, result.value);
    const element = matched || grouped?.[0]?.element;
    if (!element || !fieldVisible(element) || element.disabled) {
      return { ...result, status: 'blocked', reason: 'The field changed or became unavailable while the page validated.' };
    }
    const readback = readbackFor(element, grouped);
    const observed = readback.read(element, grouped);
    const actual = readback.report(element, observed);
    const holds = readback.holds(element, grouped, result.value, observed)
      && (element.tagName !== 'SELECT' || select2SelectionMatches(element));
    const problem = validationProblem(element);
    if (pageSettled && holds && !problem) return { ...result, actual };
    return { ...result, status: 'blocked', actual, reason: revalidationFailure(problem, pageSettled) };
  }

  async function fill(assignments) {
    const generation = ++fillGeneration;
    if ((assignments || []).length > MAX_FILL_ASSIGNMENTS) {
      const reason = `This page contains more than the ${MAX_FILL_ASSIGNMENTS}-field verified-fill safety limit. Fill it in smaller reviewed sections.`;
      const results = assignments.map((assignment) => ({ ...assignment, status: 'blocked', actual: '', reason }));
      return {
        results,
        provenance: [],
        verifiedCount: 0,
        blockedCount: results.length,
        presentationMode: presentationMode(),
        submitGate: submitGateStatus(),
        navigationGate: navigationStatus(),
      };
    }
    let results = [];
    for (const assignment of assignments || []) {
      if (generation !== fillGeneration) {
        return {
          cancelled: true,
          results,
          provenance: [],
          verifiedCount: results.filter((result) => result.status === 'verified').length,
          blockedCount: 0,
          presentationMode: presentationMode(),
          submitGate: submitGateStatus(),
          navigationGate: navigationStatus(),
        };
      }
      results.push(await writeAssignment(assignment));
    }
    const pageValidation = await waitForPageValidation(generation);
    if (pageValidation.cancelled) {
      return {
        cancelled: true,
        results,
        provenance: [],
        verifiedCount: results.filter((result) => result.status === 'verified').length,
        blockedCount: results.filter((result) => result.status === 'blocked').length,
        presentationMode: presentationMode(),
        submitGate: submitGateStatus(),
        navigationGate: navigationStatus(),
      };
    }
    results = results.map((result) => revalidateAssignment(result, pageValidation.settled));
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
      presentationMode: presentationMode(),
      submitGate: submitGateStatus(),
      navigationGate: navigationStatus(),
    };
  }

  async function handleMessage(message) {
    if (message?.type === 'NAVA_PING') {
      return {
        ok: true,
        agentVersion: PAGE_AGENT_VERSION,
        adaptersReady: typeof globalThis.NavaSiteAdapters?.fieldPolicy === 'function',
        tools: PAGE_TOOL_DEFINITIONS,
      };
    }
    if (message?.type === 'NAVA_CANCEL') {
      fillGeneration += 1;
      return { ok: true, cancelled: true };
    }
    if (['NAVA_SCAN', 'NAVA_FILL', 'NAVA_NAVIGATION_STATUS', 'NAVA_ADVANCE'].includes(message?.type)
      && !routeAuthorized(message.routePolicy)) {
      return { ok: false, error: 'The application location changed before this command reached the page. No form action was taken.' };
    }
    if (message?.type === 'NAVA_SCAN') {
      const fields = scanFields();
      return {
        ok: true,
        page: {
          title: document.title,
          url: location.href,
          domain: location.hostname,
        },
        fields,
        tools: PAGE_TOOL_DEFINITIONS,
        playbook: playbookStatus(),
        analysis: engine.buildAnalysis(fields, message.participant || {}),
        submitGate: submitGateStatus(),
        navigationGate: navigationStatus(),
      };
    }
    if (message?.type === 'NAVA_FILL') {
      return { ok: true, ...(await fill(message.assignments || [])) };
    }
    if (message?.type === 'NAVA_NAVIGATION_STATUS') {
      return { ok: true, navigationGate: navigationStatus() };
    }
    if (message?.type === 'NAVA_ADVANCE') {
      return { ok: true, ...advance() };
    }
    return { ok: false, error: 'Unknown message.' };
  }

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
