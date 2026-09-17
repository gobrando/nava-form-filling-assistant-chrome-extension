const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const agentSource = fs.readFileSync(path.join(root, 'content/form-agent.js'), 'utf8');

function control(text, selectors = []) {
  return {
    tagName: 'BUTTON',
    type: 'button',
    id: '',
    value: '',
    textContent: text,
    disabled: false,
    clicked: false,
    getAttribute() { return ''; },
    getBoundingClientRect() { return { width: 100, height: 30 }; },
    closest() { return null; },
    matches(selector) { return selectors.includes(selector); },
    focus() {},
    click() { this.clicked = true; },
  };
}

function agentHarness(url, { demo = false, controls = [] } = {}) {
  const parsed = new URL(url);
  let listener;
  const controlsSelector = 'button, input[type="submit"], input[type="button"], a[href], [role="button"]';
  const interactionRoot = {
    querySelectorAll(selector) {
      return selector === controlsSelector ? controls : [];
    },
  };
  const document = {
    title: 'Test application',
    documentElement: { dataset: demo ? { navaDemoFlow: 'true' } : {} },
    querySelector(selector) {
      return selector === 'main, [role="main"]' ? interactionRoot : null;
    },
    querySelectorAll() { return []; },
    getElementById() { return null; },
  };
  const context = {
    URLSearchParams,
    location: {
      href: parsed.href,
      origin: parsed.origin,
      hostname: parsed.hostname,
      pathname: parsed.pathname,
      search: parsed.search,
      hash: parsed.hash,
    },
    document,
    CSS: { escape: (value) => String(value) },
    getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }),
    requestAnimationFrame: (callback) => callback(),
    setTimeout,
    clearTimeout,
    NavaFormEngine: {
      normalize: (value) => String(value || '').trim().toLowerCase().replace(/\s+/g, ' '),
      compact: (value) => String(value || '').trim().toLowerCase(),
      buildAnalysis: () => ({ fields: [], assignments: [], gaps: [] }),
      valuesEquivalent: (left, right) => String(left) === String(right),
    },
    chrome: {
      runtime: {
        onMessage: {
          addListener(callback) { listener = callback; },
        },
      },
    },
  };
  context.globalThis = context;
  vm.runInNewContext(agentSource, context, { filename: 'content/form-agent.js' });

  return {
    async send(message) {
      assert.equal(typeof listener, 'function');
      return new Promise((resolve) => {
        assert.equal(listener(message, {}, resolve), true);
      });
    },
  };
}

function fillHarness(url, { describedNodes = {} } = {}) {
  const parsed = new URL(url);

  class InputElement {
    constructor({ id, label, describedBy = '' }) {
      this.tagName = 'INPUT';
      this.type = 'text';
      this.id = id;
      this.name = id;
      this.autocomplete = '';
      this.placeholder = '';
      this.maxLength = -1;
      this.required = false;
      this.disabled = false;
      this.checked = false;
      this.style = {};
      this.validationMessage = '';
      this.attributes = {
        'aria-label': label,
        'aria-describedby': describedBy,
      };
      this._value = '';
    }

    get value() { return this._value; }

    set value(next) { this._value = String(next); }

    getAttribute(name) { return this.attributes[name] || ''; }

    setAttribute(name, value) { this.attributes[name] = String(value); }

    getBoundingClientRect() { return { width: 200, height: 32 }; }

    closest() { return null; }

    checkValidity() { return true; }

    dispatchEvent() { return true; }

    focus() {}

    blur() {}
  }

  const interactionRoot = { querySelectorAll() { return []; } };
  const fields = [];
  const document = {
    title: 'Fill regression fixture',
    documentElement: { dataset: {} },
    querySelector(selector) {
      if (selector === 'main, [role="main"]') return interactionRoot;
      return null;
    },
    querySelectorAll(selector) {
      if (selector === 'input, select, textarea' || selector === 'input') return fields;
      return [];
    },
    getElementById(id) { return describedNodes[id] || null; },
  };
  const context = {
    URLSearchParams,
    location: {
      href: parsed.href,
      origin: parsed.origin,
      hostname: parsed.hostname,
      pathname: parsed.pathname,
      search: parsed.search,
      hash: parsed.hash,
    },
    document,
    CSS: { escape: (value) => String(value) },
    Event: class EventMock {
      constructor(type, options = {}) {
        this.type = type;
        Object.assign(this, options);
      }
    },
    HTMLInputElement: InputElement,
    HTMLTextAreaElement: class TextAreaElement {},
    HTMLSelectElement: class SelectElement {},
    getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }),
    requestAnimationFrame: (callback) => callback(),
    setTimeout,
    clearTimeout,
    NavaFormEngine: {
      normalize: (value) => String(value || '').trim().toLowerCase().replace(/\s+/g, ' '),
      compact: (value) => String(value || '').trim().toLowerCase(),
      buildAnalysis: () => ({ fields: [], assignments: [], gaps: [] }),
      valuesEquivalent: (left, right) => String(left) === String(right),
    },
  };
  context.globalThis = context;
  const instrumentedSource = agentSource.replace(
    /\}\)\(\);\s*$/,
    'globalThis.__NavaContentAgentTest = { fill, fieldMap };\n})();',
  );
  vm.runInNewContext(instrumentedSource, context, { filename: 'content/form-agent.js' });

  return {
    input(options) {
      const element = new InputElement(options);
      fields.push(element);
      return element;
    },
    async fill(fieldKey, element, value) {
      context.__NavaContentAgentTest.fieldMap.set(fieldKey, element);
      return context.__NavaContentAgentTest.fill([{
        fieldKey,
        label: element.getAttribute('aria-label'),
        value,
        source: 'test record',
        detail: 'Regression fixture',
        sensitive: false,
      }]);
    },
    async fillAssignments(assignments) {
      return context.__NavaContentAgentTest.fill(assignments);
    },
  };
}

function describedNode({ id, textContent, role = '', ariaLive = '', className = '' }) {
  return {
    id,
    textContent,
    className,
    getAttribute(name) {
      if (name === 'role') return role;
      if (name === 'aria-live') return ariaLive;
      return '';
    },
    getBoundingClientRect() { return { width: 300, height: 24 }; },
  };
}

function routePolicy(url, overrides = {}) {
  const parsed = new URL(url);
  return {
    origins: [parsed.origin],
    exactPaths: [parsed.pathname],
    expectedPath: parsed.pathname,
    expectedSearch: parsed.search,
    expectedHash: parsed.hash,
    ...overrides,
  };
}

test('route authorization binds commands to normalized search and hash state', async () => {
  const url = 'https://benefitscal.com/ApplyForBenefits/ABNAV?a=1&b=2#household';
  const harness = agentHarness(url);

  const accepted = await harness.send({
    type: 'NAVA_NAVIGATION_STATUS',
    routePolicy: routePolicy(url, { expectedSearch: '?b=2&a=1', expectedHash: 'household' }),
  });
  assert.equal(accepted.ok, true, 'equivalent query parameter order and normalized hash should be accepted');

  const wrongSearch = await harness.send({
    type: 'NAVA_NAVIGATION_STATUS',
    routePolicy: routePolicy(url, { expectedSearch: '?a=1&b=3' }),
  });
  assert.equal(wrongSearch.ok, false);

  const wrongHash = await harness.send({
    type: 'NAVA_NAVIGATION_STATUS',
    routePolicy: routePolicy(url, { expectedHash: '#income' }),
  });
  assert.equal(wrongHash.ok, false);

  const unexpectedSearch = await harness.send({
    type: 'NAVA_NAVIGATION_STATUS',
    routePolicy: routePolicy(url, { expectedSearch: '' }),
  });
  assert.equal(unexpectedSearch.ok, false, 'an explicitly empty expected search must reject a page with query state');
});

test('oversized fill batches are rejected before any field write', async () => {
  const harness = fillHarness('https://benefitscal.com/ApplyForBenefits/ABNMI');
  const assignments = Array.from({ length: 81 }, (_, index) => ({
    fieldKey: `field:${index}`,
    label: `Field ${index}`,
    value: `Value ${index}`,
    source: 'test record',
    detail: 'Bounded-fill regression fixture',
    sensitive: false,
  }));
  const result = await harness.fillAssignments(assignments);
  assert.equal(result.verifiedCount, 0);
  assert.equal(result.blockedCount, 81);
  assert.equal(result.results.length, 81);
  assert.match(result.results[0].reason, /80-field verified-fill safety limit/);
});

test('production playbooks do not treat a generic Next label as authorization', async () => {
  const url = 'https://benefitscal.com/ApplyForBenefits/ABNAV';
  const next = control('Next');
  const harness = agentHarness(url, { controls: [next] });
  const response = await harness.send({ type: 'NAVA_ADVANCE', routePolicy: routePolicy(url) });

  assert.equal(response.ok, true);
  assert.equal(response.advanced, false);
  assert.equal(response.navigationGate.kind, 'manual');
  assert.equal(next.clicked, false);
});

test('a route-specific production rule authorizes only its explicit label', async () => {
  const url = 'https://benefitscal.com/ApplyForBenefits/ABNAV';
  const start = control('Start');
  const harness = agentHarness(url, { controls: [start] });
  const response = await harness.send({ type: 'NAVA_ADVANCE', routePolicy: routePolicy(url) });

  assert.equal(response.ok, true);
  assert.equal(response.advanced, true);
  assert.equal(response.navigationGate.kind, 'next');
  assert.equal(response.navigationGate.text, 'Start');
  assert.equal(start.clicked, true);
});

test('the inspected BenefitsCal continuation selector is authorized on application pages', async () => {
  const url = 'https://benefitscal.com/ApplyForBenefits/ABNMI';
  const next = control('Next', ['button[name="common_continue"]']);
  const harness = agentHarness(url, { controls: [next] });
  const response = await harness.send({ type: 'NAVA_ADVANCE', routePolicy: routePolicy(url) });

  assert.equal(response.ok, true);
  assert.equal(response.advanced, true);
  assert.equal(response.navigationGate.kind, 'next');
  assert.equal(next.clicked, true);
});

test('generic continuation labels remain authorized only on exact trusted demo fixtures', async () => {
  const trustedUrl = 'http://127.0.0.1:4173/demo/multi-page.html';
  const trusted = agentHarness(trustedUrl, { demo: true, controls: [control('Next')] });
  const trustedResponse = await trusted.send({
    type: 'NAVA_NAVIGATION_STATUS',
    routePolicy: routePolicy(trustedUrl),
  });
  assert.equal(trustedResponse.navigationGate.kind, 'next');

  const untrustedUrl = 'http://127.0.0.1:4173/not-the-demo.html';
  const untrusted = agentHarness(untrustedUrl, { demo: true, controls: [control('Next')] });
  const untrustedResponse = await untrusted.send({
    type: 'NAVA_NAVIGATION_STATUS',
    routePolicy: routePolicy(untrustedUrl),
  });
  assert.equal(untrustedResponse.navigationGate.kind, 'manual');
});

test('production playbooks support explicit safe labels, selectors, and route rules', () => {
  const start = agentSource.indexOf('function isPlaybookAdvanceControl');
  const end = agentSource.indexOf('function hasFinalPageSignal', start);
  const implementation = agentSource.slice(start, end);

  assert.match(implementation, /if \(trustedDemoFixture\(\)\) return isSafeAdvanceText\(text\)/);
  assert.match(implementation, /playbook\?\.safeAdvanceLabels/);
  assert.match(implementation, /playbook\?\.safeAdvanceSelectors/);
  assert.match(implementation, /playbook\?\.safeAdvanceRules/);
  assert.doesNotMatch(implementation, /^\s*return isSafeAdvanceText\(text\)/m);
});

test('ordinary aria-describedby help text does not block a verified fill', async () => {
  const help = describedNode({
    id: 'email-help',
    textContent: 'Enter an email address, then choose or select the preferred contact method.',
  });
  const harness = fillHarness('https://benefitscal.com/ApplyForBenefits/ABNMI', {
    describedNodes: { 'email-help': help },
  });
  const input = harness.input({ id: 'email', label: 'Email', describedBy: 'email-help' });

  const response = await harness.fill('field:email', input, 'person@example.org');

  assert.equal(response.verifiedCount, 1);
  assert.equal(response.blockedCount, 0);
  assert.equal(response.results[0].status, 'verified');
});

test('final page-level revalidation catches a delayed value revert and async invalid state', async () => {
  const revertHarness = fillHarness('https://benefitscal.com/ApplyForBenefits/ABNMI');
  const revertInput = revertHarness.input({ id: 'phone', label: 'Phone' });
  const revertFill = revertHarness.fill('field:phone', revertInput, '5551234567');
  setTimeout(() => { revertInput.value = ''; }, 900);

  const invalidHarness = fillHarness('https://benefitscal.com/ApplyForBenefits/ABNMI');
  const invalidInput = invalidHarness.input({ id: 'zip', label: 'ZIP code' });
  const invalidFill = invalidHarness.fill('field:zip', invalidInput, '92595');
  setTimeout(() => { invalidInput.setAttribute('aria-invalid', 'true'); }, 900);

  const [reverted, invalid] = await Promise.all([revertFill, invalidFill]);

  assert.equal(reverted.results[0].status, 'blocked');
  assert.match(reverted.results[0].reason, /changed this value during page validation/i);
  assert.equal(invalid.results[0].status, 'blocked');
  assert.match(invalid.results[0].reason, /marked this value invalid/i);
});
