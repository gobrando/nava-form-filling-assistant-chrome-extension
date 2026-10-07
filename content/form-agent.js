// Page agent composition root: the version guard, the page tool definitions, route authorization for every page command, the verified-fill loop with its page-level validation wait, and the message handler; the DOM, field-inventory, navigation-gate, and value-writer modules load before it.
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

  function nextScanNumber() {
    scanNumber += 1;
    return scanNumber;
  }

  // The page-agent modules load before this file in the same isolated world. This file reads the
  // engines and owns the state they share (fieldMap, groupMap, the scan counter, fillGeneration),
  // handing each module what it needs through create().
  const dom = globalThis.NavaPageDom.create({ engine });
  const { visible } = dom;
  const { scanFields, rawCurrentValue } = globalThis.NavaPageFieldInventory.create({
    engine,
    siteAdapters: () => globalThis.NavaSiteAdapters,
    dom,
    fieldMap,
    groupMap,
    nextScanNumber,
  });
  const { playbookStatus, submitGateStatus, navigationStatus, advance } = globalThis.NavaPageNavigationGate.create({
    engine,
    dom,
    trustedDemoFixture,
    normalizeSearch,
    normalizeHash,
  });
  const { writeAssignment, revalidateAssignment, maskValue } = globalThis.NavaPageValueWriters.create({
    engine,
    dom,
    rawCurrentValue,
    fieldMap,
    groupMap,
    presentationMode,
    nextAnimationFrame,
    delay,
    settleTiming: { PRODUCTION_SETTLE_MS, PRESENTATION_FIELD_MS, DOM_QUIET_MS, MAX_SETTLE_MS },
  });

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
