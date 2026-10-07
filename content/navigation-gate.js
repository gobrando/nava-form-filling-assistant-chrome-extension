// Navigation gate for the page agent: bundled site playbooks, human checkpoints (bot checks and one-time codes), the submit gate, page signatures, and the rules that let only an allowlisted continuation control advance while every final action stays with the caseworker.
(function installPageNavigationGate(root) {
  'use strict';

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

  /**
   * deps:
   * - engine: the form engine (normalize).
   * - dom: the page DOM helpers (visible, cleanText, fieldVisible, explicitLabel, labelledByText, questionText, labelFor).
   * - trustedDemoFixture(): true only on the exact local demo fixtures.
   * - normalizeSearch, normalizeHash: the agent's route-policy normalizers, shared with safe-advance route rules.
   */
  function create(deps) {
    const { engine, dom, trustedDemoFixture, normalizeSearch, normalizeHash } = deps;
    const { visible, cleanText, fieldVisible, explicitLabel, labelledByText, questionText, labelFor } = dom;

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

    return { playbookStatus, submitGateStatus, navigationStatus, advance };
  }

  const api = { create };
  root.NavaPageNavigationGate = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
