const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
// The page-agent modules form-agent.js composes, by literal path in manifest order. Every harness loads them
// into its vm context before form-agent.js, the way Chrome loads the manifest content scripts.
const CONTENT_MODULES = [
  'content/page-dom.js',
  'content/field-inventory.js',
  'content/navigation-gate.js',
  'content/value-writers.js',
];
const moduleSources = CONTENT_MODULES.map((file) => [file, fs.readFileSync(path.join(root, file), 'utf8')]);
const agentSource = fs.readFileSync(path.join(root, 'content/form-agent.js'), 'utf8');
const navigationGateSource = fs.readFileSync(path.join(root, 'content/navigation-gate.js'), 'utf8');
const valueWritersSource = fs.readFileSync(path.join(root, 'content/value-writers.js'), 'utf8');
const formEngine = require(path.join(root, 'shared/form-engine.js'));
const siteAdapters = require(path.join(root, 'shared/site-adapters.js'));

/** Runs the content modules, then form-agent.js (or an instrumented copy of it), in one vm context. */
function loadPageAgent(context, source = agentSource) {
  vm.createContext(context);
  for (const [file, moduleSource] of moduleSources) vm.runInContext(moduleSource, context, { filename: file });
  vm.runInContext(source, context, { filename: 'content/form-agent.js' });
}

/** The source between two markers, which must both be present and in order. */
function section(source, start, end) {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.notEqual(startIndex, -1, `missing section start: ${start}`);
  assert.notEqual(endIndex, -1, `missing section end: ${end}`);
  return source.slice(startIndex, endIndex);
}

function control(text, selectors = [], attributes = {}) {
  return {
    tagName: 'BUTTON',
    type: 'button',
    id: '',
    value: '',
    textContent: text,
    disabled: false,
    clicked: false,
    getAttribute(name) { return attributes[name] || ''; },
    getBoundingClientRect() { return { width: 100, height: 30 }; },
    closest() { return null; },
    matches(selector) { return selectors.includes(selector); },
    focus() {},
    click() { this.clicked = true; },
  };
}

function visibleNode(text, tagName = 'H1') {
  return {
    tagName,
    textContent: text,
    getAttribute() { return ''; },
    getBoundingClientRect() { return { width: 300, height: 32 }; },
  };
}

function applicationCard(headingText, parentElement = null) {
  const heading = visibleNode(headingText, 'H2');
  return {
    parentElement,
    querySelectorAll(selector) {
      return selector === 'h2, [role="heading"][aria-level="2"]' ? [heading] : [];
    },
  };
}

function agentHarness(url, {
  demo = false,
  controls = [],
  headings = [],
  fields = [],
  botToken = null,
  botWidget = null,
} = {}) {
  const parsed = new URL(url);
  let listener;
  const controlsSelector = 'button, input[type="submit"], input[type="button"], a[href], [role="button"]';
  const interactionRoot = {
    querySelectorAll(selector) {
      if (selector === controlsSelector) return controls;
      if (selector === 'h1') return headings.filter((heading) => heading.tagName === 'H1');
      if (selector === 'h5') return headings.filter((heading) => heading.tagName === 'H5');
      return [];
    },
  };
  const document = {
    title: 'Test application',
    documentElement: { dataset: demo ? { navaDemoFlow: 'true' } : {} },
    querySelector(selector) {
      if (selector === 'main, [role="main"]') return interactionRoot;
      if (selector.includes('[name="g-recaptcha-response"]')) return botToken;
      if (selector.includes('iframe[src*="recaptcha"]')) return botWidget;
      return null;
    },
    querySelectorAll(selector) {
      if (selector === 'h1, h2, [role="heading"]') return headings;
      if (selector === 'input, select, textarea') return fields;
      if (selector === 'input') return fields.filter((field) => field.tagName === 'INPUT');
      if (selector === 'input[type="checkbox"], input[type="radio"]') {
        return fields.filter((field) => ['checkbox', 'radio'].includes(field.type));
      }
      if (selector === 'button, input[type="submit"], input[type="button"], [role="button"]') return controls;
      return [];
    },
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
    NavaSiteAdapters: siteAdapters,
    chrome: {
      runtime: {
        onMessage: {
          addListener(callback) { listener = callback; },
        },
      },
    },
  };
  context.globalThis = context;
  loadPageAgent(context);

  return {
    async send(message) {
      assert.equal(typeof listener, 'function');
      return new Promise((resolve) => {
        assert.equal(listener(message, {}, resolve), true);
      });
    },
  };
}

function mockField({
  tagName = 'INPUT',
  type = 'text',
  id = '',
  name = '',
  value = '',
  label = '',
  className = '',
  pattern = '',
  required = false,
  disabled = false,
  options = [],
  group = null,
  hidden = false,
  nextElementSibling = null,
  autocomplete = '',
  placeholder = '',
  maxLength = -1,
  checked = false,
  attributes = {},
  searchRoot = null,
} = {}) {
  return {
    tagName,
    type,
    id,
    name,
    value,
    textContent: '',
    className,
    autocomplete,
    placeholder,
    maxLength,
    required,
    disabled,
    checked,
    options,
    parentElement: null,
    nextElementSibling,
    getAttribute(attribute) {
      if (attribute === 'aria-label') return label;
      if (attribute === 'pattern') return pattern;
      if (attribute === 'placeholder') return placeholder;
      return attributes[attribute] || '';
    },
    getBoundingClientRect() { return hidden ? { width: 0, height: 0 } : { width: 200, height: 32 }; },
    closest(selector) {
      if (selector.includes('fieldset')) return group;
      if (selector.includes('[role="search"]')) return searchRoot;
      return null;
    },
  };
}

function scanHarness(url, { fields = [], controls = [], labels = {}, nodes = {}, adapter = siteAdapters } = {}) {
  const parsed = new URL(url);
  const controlsSelector = 'button, input[type="submit"], input[type="button"], a[href], [role="button"]';
  const interactionRoot = {
    querySelectorAll(selector) {
      if (selector === controlsSelector) return controls;
      if (selector === 'h1') return [];
      return [];
    },
  };
  const document = {
    title: 'Scan regression fixture',
    documentElement: { dataset: {} },
    querySelector(selector) {
      if (selector === 'main, [role="main"]') return interactionRoot;
      const labelFor = selector.match(/^label\[for="(.+)"\]$/);
      if (labelFor) return labels[labelFor[1]] || null;
      return null;
    },
    querySelectorAll(selector) {
      if (selector === 'input, select, textarea') return fields;
      if (selector === 'input') return fields.filter((field) => field.tagName === 'INPUT');
      if (selector === 'input[type="checkbox"], input[type="radio"]') {
        return fields.filter((field) => ['checkbox', 'radio'].includes(field.type));
      }
      if (selector === 'button, input[type="submit"], input[type="button"], [role="button"]') return controls;
      return [];
    },
    getElementById(id) { return nodes[id] || null; },
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
      buildAnalysis: (descriptions) => ({ descriptions }),
      valuesEquivalent: (left, right) => String(left) === String(right),
    },
    NavaSiteAdapters: adapter,
  };
  context.globalThis = context;
  const instrumentedSource = agentSource.replace(
    /\}\)\(\);\s*$/,
    'globalThis.__NavaContentAgentTest = { scanFields, submitGateStatus, groupMap, fieldMap };\n})();',
  );
  loadPageAgent(context, instrumentedSource);
  return context.__NavaContentAgentTest;
}

function fillHarness(url, { describedNodes = {}, adapter = siteAdapters } = {}) {
  const parsed = new URL(url);

  class InputElement {
    constructor({ id, label, describedBy = '', type = 'text', name = id, value = '', className = '', group = null }) {
      this.tagName = 'INPUT';
      this.type = type;
      this.id = id;
      this.name = name;
      this.className = className;
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
      this._value = String(value);
      this.group = group;
    }

    get value() { return this._value; }

    set value(next) { this._value = String(next); }

    getAttribute(name) { return this.attributes[name] || ''; }

    setAttribute(name, value) { this.attributes[name] = String(value); }

    getBoundingClientRect() { return { width: 200, height: 32 }; }

    closest(selector) {
      if (selector.includes('fieldset')) return this.group;
      return null;
    }

    checkValidity() { return true; }

    dispatchEvent() { return true; }

    focus() {}

    blur() {}
  }

  class SelectElement {
    constructor({ id, label, name = id, options = [], value = '', select2 = null }) {
      this.tagName = 'SELECT';
      this.type = 'select-one';
      this.id = id;
      this.name = name;
      this.className = '';
      this.autocomplete = '';
      this.placeholder = '';
      this.maxLength = -1;
      this.required = false;
      this.disabled = false;
      this.checked = false;
      this.style = {};
      this.validationMessage = '';
      this.attributes = { 'aria-label': label };
      this.options = options.map(([optionValue, text]) => ({ value: optionValue, textContent: text, disabled: false, hidden: false }));
      this._value = String(value);
      this.nextElementSibling = select2;
      this.parentElement = null;
      this.events = [];
    }

    get value() { return this._value; }

    set value(next) { this._value = String(next); }

    getAttribute(name) { return this.attributes[name] || ''; }

    getBoundingClientRect() { return { width: 200, height: 32 }; }

    closest() { return null; }

    checkValidity() { return true; }

    dispatchEvent(event) {
      this.events.push(event.type);
      return true;
    }

    focus() {}

    blur() {}
  }

  class EventMock {
    constructor(type, options = {}) {
      this.type = type;
      Object.assign(this, options);
    }
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
      if (selector === 'input[type="checkbox"], input[type="radio"]') {
        return fields.filter((field) => ['checkbox', 'radio'].includes(field.type));
      }
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
    Event: EventMock,
    KeyboardEvent: class KeyboardEventMock extends EventMock {},
    InputEvent: class InputEventMock extends EventMock {},
    HTMLInputElement: InputElement,
    HTMLTextAreaElement: class TextAreaElement {},
    HTMLSelectElement: SelectElement,
    getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }),
    requestAnimationFrame: (callback) => callback(),
    setTimeout,
    clearTimeout,
    NavaFormEngine: {
      normalize: (value) => String(value ?? '').trim().toLowerCase().replace(/\s+/g, ' '),
      compact: (value) => String(value || '').trim().toLowerCase(),
      buildAnalysis: () => ({ fields: [], assignments: [], gaps: [] }),
      valuesEquivalent: (left, right) => String(left) === String(right),
    },
    NavaSiteAdapters: adapter,
  };
  context.globalThis = context;
  const instrumentedSource = agentSource.replace(
    /\}\)\(\);\s*$/,
    'globalThis.__NavaContentAgentTest = { fill, scanFields, fieldMap, groupMap };\n})();',
  );
  loadPageAgent(context, instrumentedSource);

  return {
    input(options) {
      const element = new InputElement(options);
      fields.push(element);
      return element;
    },
    select(options) {
      const element = new SelectElement(options);
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
    scan() {
      return context.__NavaContentAgentTest.scanFields();
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

test('the vm harness loads the manifest content modules in manifest order, form-agent.js last', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
  const contentScripts = manifest.content_scripts[0].js.filter((file) => file.startsWith('content/'));
  assert.deepEqual(contentScripts, [...CONTENT_MODULES, 'content/form-agent.js']);
});

test('content modules only install a factory at load, never touch the page, and tolerate re-injection', () => {
  // No document, location, or engine: any DOM work at load would throw here.
  const context = {};
  context.globalThis = context;
  vm.createContext(context);
  for (const [file, moduleSource] of moduleSources) {
    vm.runInContext(moduleSource, context, { filename: file });
    vm.runInContext(moduleSource, context, { filename: file });
  }
  const globals = ['NavaPageDom', 'NavaPageFieldInventory', 'NavaPageNavigationGate', 'NavaPageValueWriters'];
  const installed = Object.fromEntries(globals.map((name) => [name, Object.keys(context[name])]));
  assert.deepEqual(JSON.parse(JSON.stringify(installed)), {
    NavaPageDom: ['create'],
    NavaPageFieldInventory: ['create'],
    NavaPageNavigationGate: ['create'],
    NavaPageValueWriters: ['create'],
  });
  for (const [, moduleSource] of moduleSources) assert.doesNotMatch(moduleSource, /function delay\b/);
});

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
  const start = control('Start', [], { 'aria-label': 'Start Your Information' });
  const harness = agentHarness(url, { controls: [start] });
  const response = await harness.send({ type: 'NAVA_ADVANCE', routePolicy: routePolicy(url) });

  assert.equal(response.ok, true);
  assert.equal(response.advanced, true);
  assert.equal(response.navigationGate.kind, 'next');
  assert.equal(response.navigationGate.text, 'Start Your Information');
  assert.equal(start.clicked, true);
});

test('bare ABNAV Start controls require an exact allowed nearest-card heading', async () => {
  const url = 'https://benefitscal.com/ApplyForBenefits/ABNAV';
  const allowedHeadings = [
    'Your Information',
    'People',
    'Household Details',
    'Income',
    'Expenses',
    'Assets',
    'Other Situations',
    'Document Upload',
  ];

  for (const heading of allowedHeadings) {
    const start = control('Start');
    start.parentElement = applicationCard(heading);
    const harness = agentHarness(url, { controls: [start] });
    const response = await harness.send({ type: 'NAVA_ADVANCE', routePolicy: routePolicy(url) });
    assert.equal(response.advanced, true, `${heading} should authorize its own Start control`);
    assert.equal(start.clicked, true);
  }
});

test('bare ABNAV Start rejects Review & Submit, unknown, and inexact card headings', async () => {
  const url = 'https://benefitscal.com/ApplyForBenefits/ABNAV';
  for (const heading of ['Review & Submit', 'Case summary', 'Household', 'People and relationships']) {
    const start = control('Start');
    start.parentElement = applicationCard(heading);
    const harness = agentHarness(url, { controls: [start] });
    const response = await harness.send({ type: 'NAVA_ADVANCE', routePolicy: routePolicy(url) });
    assert.equal(response.advanced, false, `${heading} must not authorize Start`);
    assert.equal(start.clicked, false);
  }
});

test('bare contextual Start authorization is limited to the exact BenefitsCal ABNAV host and path', async () => {
  const urls = [
    'https://www.benefitscal.com/ApplyForBenefits/ABNAV',
    'https://benefitscal.com/ApplyForBenefits/ABNAV/',
    'https://benefitscal.com/ApplyForBenefits/ABNMI',
  ];
  for (const url of urls) {
    const start = control('Start');
    start.parentElement = applicationCard('People');
    const harness = agentHarness(url, { controls: [start] });
    const response = await harness.send({ type: 'NAVA_ADVANCE', routePolicy: routePolicy(url) });
    assert.equal(response.advanced, false, `${url} must not receive ABNAV contextual authorization`);
    assert.equal(start.clicked, false);
  }
});

test('bare ABNAV Start uses the nearest card heading and still requires an enabled control', async () => {
  const url = 'https://benefitscal.com/ApplyForBenefits/ABNAV';
  const allowedOuterCard = applicationCard('People');
  const reviewInnerCard = applicationCard('Review & Submit', allowedOuterCard);
  const nestedStart = control('Start');
  nestedStart.parentElement = reviewInnerCard;
  const nestedHarness = agentHarness(url, { controls: [nestedStart] });
  const nestedResponse = await nestedHarness.send({ type: 'NAVA_ADVANCE', routePolicy: routePolicy(url) });
  assert.equal(nestedResponse.advanced, false);
  assert.equal(nestedStart.clicked, false);

  const disabledStart = control('Start');
  disabledStart.disabled = true;
  disabledStart.parentElement = applicationCard('Income');
  const disabledHarness = agentHarness(url, { controls: [disabledStart] });
  const disabledResponse = await disabledHarness.send({ type: 'NAVA_ADVANCE', routePolicy: routePolicy(url) });
  assert.equal(disabledResponse.advanced, false);
  assert.equal(disabledStart.clicked, false);
});

test('the BenefitsCal overview authorizes only exact Begin on the exact ABOVR route', async () => {
  const url = 'https://benefitscal.com/ApplyForBenefits/begin/ABOVR?lang=en';
  const begin = control('Begin');
  const harness = agentHarness(url, { controls: [begin] });
  const response = await harness.send({ type: 'NAVA_ADVANCE', routePolicy: routePolicy(url) });

  assert.equal(response.advanced, true);
  assert.equal(response.navigationGate.kind, 'next');
  assert.equal(begin.clicked, true);
  assert.match(navigationGateSource, /location\.assign\('\/ApplyForBenefits\/ABHLT'\)/);

  const wrongUrl = 'https://benefitscal.com/ApplyForBenefits/ABHLT?lang=en';
  const wrongBegin = control('Begin', ['button[name="common_continue"]']);
  const wrongHarness = agentHarness(wrongUrl, { controls: [wrongBegin] });
  const wrongResponse = await wrongHarness.send({ type: 'NAVA_ADVANCE', routePolicy: routePolicy(wrongUrl) });
  assert.equal(wrongResponse.advanced, false);
  assert.equal(wrongBegin.clicked, false);
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

test('the reused BenefitsCal common_continue selector cannot authorize an unsafe label', async () => {
  const url = 'https://benefitscal.com/ApplyForBenefits/ABNMI';
  const confirm = control('Confirm household', ['button[name="common_continue"]']);
  const harness = agentHarness(url, { controls: [confirm] });
  const response = await harness.send({ type: 'NAVA_ADVANCE', routePolicy: routePolicy(url) });

  assert.equal(response.advanced, false);
  assert.equal(confirm.clicked, false);
});

test('ABNAV subsection copy does not create a false final-review gate', async () => {
  const url = 'https://benefitscal.com/ApplyForBenefits/ABNAV';
  const start = control('Start', [], { 'aria-label': 'Start Household' });
  const harness = agentHarness(url, {
    controls: [start],
    headings: [visibleNode('Application Summary'), visibleNode('Review & Submit', 'H2')],
  });
  const response = await harness.send({ type: 'NAVA_NAVIGATION_STATUS', routePolicy: routePolicy(url) });

  assert.equal(response.navigationGate.kind, 'next');
  assert.equal(response.navigationGate.text, 'Start Household');
});

test('ABNAV page signatures include control label and enabled state', async () => {
  const url = 'https://benefitscal.com/ApplyForBenefits/ABNAV';
  const stage = control('Start', [], { 'aria-label': 'People Not Available' });
  stage.disabled = true;
  const harness = agentHarness(url, { controls: [stage], headings: [visibleNode('Application Summary')] });
  const before = await harness.send({ type: 'NAVA_NAVIGATION_STATUS', routePolicy: routePolicy(url) });

  stage.disabled = false;
  stage.getAttribute = (name) => name === 'aria-label' ? 'Start People' : '';
  const after = await harness.send({ type: 'NAVA_NAVIGATION_STATUS', routePolicy: routePolicy(url) });

  assert.notEqual(before.navigationGate.pageSignature, after.navigationGate.pageSignature);
  assert.equal(after.navigationGate.kind, 'next');
});

test('an IHSS affirmation checkbox is a final-review boundary', async () => {
  const url = 'https://riversideihss.org/IntakeApp/Apply';
  const affirmation = {
    tagName: 'INPUT',
    type: 'checkbox',
    id: 'affirmation',
    name: 'affirmation',
    value: 'yes',
    textContent: '',
    autocomplete: '',
    getAttribute(name) { return name === 'aria-label' ? 'I affirm that the information is true' : ''; },
    getBoundingClientRect() { return { width: 20, height: 20 }; },
    closest() { return null; },
  };
  const harness = agentHarness(url, { fields: [affirmation] });
  const response = await harness.send({ type: 'NAVA_NAVIGATION_STATUS', routePolicy: routePolicy(url) });

  assert.equal(response.navigationGate.kind, 'final_review');
});

test('the exact IHSS Section 9 affirmation heading is a final-review boundary', async () => {
  const url = 'https://riversideihss.org/IntakeApp/Apply';
  const harness = agentHarness(url, { headings: [visibleNode('Section 9 - Affirmation', 'H5')] });
  const response = await harness.send({ type: 'NAVA_NAVIGATION_STATUS', routePolicy: routePolicy(url) });

  assert.equal(response.navigationGate.kind, 'final_review');

  const unrelatedUrl = 'https://benefitscal.com/ApplyForBenefits/ABNAV';
  const unrelated = agentHarness(unrelatedUrl, { headings: [visibleNode('Section 9 - Affirmation', 'H5')] });
  const unrelatedResponse = await unrelated.send({
    type: 'NAVA_NAVIGATION_STATUS',
    routePolicy: routePolicy(unrelatedUrl),
  });
  assert.notEqual(unrelatedResponse.navigationGate.kind, 'final_review');
});

test('input type button submit controls are included in the submit gate', async () => {
  const url = 'https://riversideihss.org/IntakeApp/Apply';
  const submit = control('Submit Application');
  submit.tagName = 'INPUT';
  submit.type = 'button';
  submit.value = 'Submit Application';
  const harness = agentHarness(url, { controls: [submit] });
  const response = await harness.send({ type: 'NAVA_SCAN', participant: {}, routePolicy: routePolicy(url) });

  assert.equal(response.submitGate.found, true);
  assert.equal(response.submitGate.text, 'Submit Application');
});

test('reCAPTCHA, hCaptcha, and Turnstile checkpoints are detected without solving them', async () => {
  const url = 'https://benefits.example.gov/application';
  const pending = agentHarness(url, { botWidget: {} });
  const pendingResponse = await pending.send({ type: 'NAVA_SCAN', participant: {}, routePolicy: routePolicy(url) });
  assert.equal(pendingResponse.submitGate.botCheckPresent, true);
  assert.equal(pendingResponse.submitGate.botCheckComplete, false);

  const completed = agentHarness(url, { botToken: { value: 'verified-human-token-1234567890' } });
  const completedResponse = await completed.send({ type: 'NAVA_SCAN', participant: {}, routePolicy: routePolicy(url) });
  assert.equal(completedResponse.submitGate.botCheckPresent, true);
  assert.equal(completedResponse.submitGate.botCheckComplete, true);

  const implementation = section(navigationGateSource, 'function botCheckStatus', 'function oneTimeCodeStatus');
  assert.match(implementation, /h-captcha-response/);
  assert.match(implementation, /cf-turnstile-response/);
  assert.doesNotMatch(implementation, /click\(|solve|bypass/i);
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
  const implementation = section(navigationGateSource, 'function isPlaybookAdvanceControl', 'function hasFinalPageSignal');

  assert.match(implementation, /if \(trustedDemoFixture\(\)\) return isSafeAdvanceText\(text\)/);
  assert.match(implementation, /playbook\?\.safeAdvanceLabels/);
  assert.match(implementation, /playbook\?\.safeAdvanceSelectors/);
  assert.match(implementation, /playbook\?\.safeAdvanceRules/);
  assert.doesNotMatch(implementation, /^\s*return isSafeAdvanceText\(text\)/m);
});

test('masked fallback writes retain punctuation required by an explicit field pattern', () => {
  const implementation = section(valueWritersSource, 'async function incrementalWrite', 'function optionMatch');

  assert.match(implementation, /getAttribute\?\.\('pattern'\)/);
  assert.match(implementation, /!patternRequiresFormatting/);
});

test('live-site adapter policy controls purpose, requiredness, and exclusive checkbox grouping', () => {
  const fields = [
    mockField({ id: 'firstNameTxt', name: 'firstNameTxt', label: 'First name', pattern: '[A-Za-z -]+' }),
    mockField({ type: 'checkbox', id: 'chkBxApplyYourselfYes', name: 'applyForSelf', value: 'Yes', label: 'Yes' }),
    mockField({ type: 'checkbox', id: 'chkBxApplyYourselfNo', name: 'applyForSelf', value: 'No', label: 'No' }),
  ];
  const harness = scanHarness('https://riversideihss.org/IntakeApp/Apply', { fields });
  const descriptions = harness.scanFields();

  const firstName = descriptions.find((field) => field.id === 'firstNameTxt');
  assert.equal(firstName.purpose, 'firstName');
  assert.equal(firstName.required, true);
  assert.equal(firstName.pattern, '[A-Za-z -]+');

  const choices = descriptions.filter((field) => field.groupKey === 'ihss:applying-for-self');
  assert.equal(choices.length, 2);
  assert.ok(choices.every((field) => field.type === 'radio'));
  assert.ok(choices.every((field) => field.exclusive === true));
  assert.ok(choices.every((field) => field.required === true));
  assert.deepEqual(JSON.parse(JSON.stringify(choices.map((field) => field.optionValue))), ['Yes', 'No']);
});

test('adapter sensitivity is propagated even when the live label is generic', () => {
  const caseNumber = mockField({
    id: 'edit-if-yes',
    name: 'if_yes',
    label: 'If yes',
  });
  const harness = scanHarness('https://www.ruhealth.org/appointments/apply-4-wic-form', {
    fields: [caseNumber],
  });
  const [description] = harness.scanFields();

  assert.equal(description.purpose, 'mediCalCaseNumber');
  assert.equal(description.sensitive, true);
});

test('adapter repeated-purpose scope is propagated into scanned fields', () => {
  const readLanguage = mockField({
    tagName: 'SELECT',
    type: 'select-one',
    id: 'languagePrepareToReadDrpDwn',
    name: 'languagePrepareToReadDrpDwn',
    label: 'Language for written material',
  });
  const spokenLanguage = mockField({
    tagName: 'SELECT',
    type: 'select-one',
    id: 'languagePrepareToSpeakDrpDwn',
    name: 'languagePrepareToSpeakDrpDwn',
    label: 'Language for spoken communication',
  });
  const descriptions = scanHarness('https://riversideihss.org/IntakeApp', {
    fields: [readLanguage, spokenLanguage],
  }).scanFields();

  assert.equal(descriptions.length, 2);
  assert.ok(descriptions.every((field) => field.purpose === 'primaryLanguage'));
  assert.ok(descriptions.every((field) => field.allowRepeatedPurpose === true));
});

test('an initially unchecked exclusive checkbox pair maps false to No only', async () => {
  const harness = fillHarness('https://riversideihss.org/IntakeApp/Apply');
  const yes = harness.input({
    id: 'chkBxApplyYourselfYes',
    name: 'applyForSelf',
    label: 'Yes',
    type: 'checkbox',
    value: 'Yes',
  });
  const no = harness.input({
    id: 'chkBxApplyYourselfNo',
    name: 'applyForSelf',
    label: 'No',
    type: 'checkbox',
    value: 'No',
  });
  const descriptions = harness.scan();
  const analysis = formEngine.buildAnalysis(descriptions, { ihssApplyingForSelf: false });
  const assignment = analysis.assignments.find((item) => item.fieldKey === 'ihss:applying-for-self');

  assert.equal(assignment.value, 'no');
  const response = await harness.fillAssignments([assignment]);
  assert.equal(response.results[0].status, 'verified');
  assert.equal(yes.checked, false);
  assert.equal(no.checked, true);
});

test('an adapter-supplied empty group key preserves independent checkbox fields', () => {
  const fields = [
    mockField({ type: 'checkbox', id: 'service-a', name: 'services', value: 'A', label: 'Service A' }),
    mockField({ type: 'checkbox', id: 'service-b', name: 'services', value: 'B', label: 'Service B' }),
  ];
  const adapter = {
    fieldPolicy(_hostname, _pathname, field) {
      return { groupKey: '', purpose: field.id === 'service-a' ? 'serviceA' : 'serviceB' };
    },
  };
  const descriptions = scanHarness('https://riversideihss.org/IntakeApp/Apply', { fields, adapter }).scanFields();

  assert.ok(descriptions.every((field) => field.groupKey === ''));
  assert.notEqual(descriptions[0].fieldKey, descriptions[1].fieldKey);
});

test('adapter unmapped policy is preserved for downstream required-gap handling', () => {
  const field = mockField({ id: 'representative-name', name: 'representative-name', label: 'Representative name' });
  const adapter = { fieldPolicy: () => ({ unmapped: true, required: true }) };
  const [description] = scanHarness('https://example.gov/application', { fields: [field], adapter }).scanFields();

  assert.equal(description.unmapped, true);
  assert.equal(description.required, true);
});

test('required group signals and patterns propagate into scanned field descriptions', () => {
  const heading = {
    textContent: 'Applicant postal code',
    className: 'form-required',
    getAttribute() { return ''; },
  };
  const group = {
    textContent: '',
    className: '',
    getAttribute() { return ''; },
    querySelector() { return heading; },
  };
  const postalCode = mockField({
    id: 'postal-code',
    name: 'postal-code',
    label: 'Postal code',
    pattern: '\\d{5}',
    group,
  });
  const [description] = scanHarness('https://example.gov/application', { fields: [postalCode], adapter: null }).scanFields();

  assert.equal(description.required, true);
  assert.equal(description.pattern, '\\d{5}');
});

test('a required class on an associated label marks its field required', () => {
  const email = mockField({ id: 'applicant-email', name: 'applicant-email', label: '' });
  const label = {
    textContent: 'Applicant email',
    className: 'control-label required',
    getAttribute() { return ''; },
  };
  const [description] = scanHarness('https://example.gov/application', {
    fields: [email],
    labels: { 'applicant-email': label },
    adapter: null,
  }).scanFields();

  assert.equal(description.label, 'Applicant email');
  assert.equal(description.required, true);
});

test('disabled conditional controls are omitted until a later rescan enables them', () => {
  const enabled = mockField({ id: 'enabled', name: 'enabled', label: 'Enabled field' });
  const disabled = mockField({ id: 'conditional', name: 'conditional', label: 'Conditional field', disabled: true });
  const descriptions = scanHarness('https://example.gov/application', {
    fields: [enabled, disabled],
    adapter: null,
  }).scanFields();

  assert.deepEqual(JSON.parse(JSON.stringify(descriptions.map((field) => field.id))), ['enabled']);
});

test('policy option values override identical DOM checkbox values', () => {
  const fields = [
    mockField({ type: 'checkbox', id: 'male', name: 'sex', value: 'on', label: 'Male' }),
    mockField({ type: 'checkbox', id: 'female', name: 'sex', value: 'on', label: 'Female' }),
  ];
  const adapter = {
    fieldPolicy(_hostname, _pathname, field) {
      return {
        groupKey: 'ihss:sex',
        purpose: 'gender',
        type: 'radio',
        exclusive: true,
        optionValue: field.id === 'male' ? 'Male' : 'Female',
      };
    },
  };
  const descriptions = scanHarness('https://riversideihss.org/IntakeApp/Apply', { fields, adapter }).scanFields();

  assert.deepEqual(JSON.parse(JSON.stringify(descriptions.map((field) => field.optionValue))), ['Male', 'Female']);
});

test('group writes and readback use semantic policy option values', async () => {
  const adapter = {
    fieldPolicy(_hostname, _pathname, field) {
      return {
        groupKey: 'ihss:sex',
        purpose: 'gender',
        type: 'radio',
        exclusive: true,
        optionValue: field.id === 'male' ? 'Male' : 'Female',
      };
    },
  };
  const harness = fillHarness('https://riversideihss.org/IntakeApp/Apply', { adapter });
  const male = harness.input({ id: 'male', name: 'sex', label: 'Male', type: 'checkbox', value: 'on' });
  const female = harness.input({ id: 'female', name: 'sex', label: 'Female', type: 'checkbox', value: 'on' });
  harness.scan();
  const response = await harness.fillAssignments([{
    fieldKey: 'ihss:sex',
    label: 'Sex',
    value: 'Female',
    source: 'test record',
    detail: 'Semantic option fixture',
    sensitive: false,
  }]);

  assert.equal(response.results[0].status, 'verified');
  assert.equal(response.results[0].actual, 'Female');
  assert.equal(male.checked, false);
  assert.equal(female.checked, true);
});

test('Select2-backed selects remain scannable and placeholder choices are excluded', () => {
  const rendered = { textContent: '-Select One-' };
  const container = {
    matches(selector) { return selector.includes('.select2'); },
    querySelector(selector) { return selector === '.select2-selection__rendered' ? rendered : null; },
    getBoundingClientRect() { return { width: 240, height: 36 }; },
    type: '',
  };
  const select = mockField({
    tagName: 'SELECT',
    type: 'select-one',
    id: 'ethnicDrpDwn',
    name: 'ethnicDrpDwn',
    value: 'SEL',
    label: 'Ethnicity',
    hidden: true,
    nextElementSibling: container,
    options: [
      { value: 'SEL', textContent: '-Select One-', disabled: false, hidden: false },
      { value: 'H', textContent: 'Hispanic or Latino', disabled: false, hidden: false },
    ],
  });
  const [description] = scanHarness('https://riversideihss.org/IntakeApp/Apply', { fields: [select] }).scanFields();

  assert.equal(description.value, '');
  assert.deepEqual(JSON.parse(JSON.stringify(description.options)), [
    { value: 'H', label: 'Hispanic or Latino' },
  ]);
});

test('Select2 visible selection participates in write and page-level verification', () => {
  const write = section(valueWritersSource, 'async function writeAssignment', 'function maskValue');
  const revalidate = section(valueWritersSource, 'function revalidateAssignment', 'return { writeAssignment');

  assert.match(write, /select2SelectionMatches\(element\)/);
  assert.match(revalidate, /select2SelectionMatches\(element\)/);
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

test('NAVA_SUBMIT_STATUS is not a page command; the submit gate is reported only with scan, fill, and advance', async () => {
  const url = 'https://riversideihss.org/IntakeApp/Apply';
  const harness = agentHarness(url, { controls: [control('Submit Application')] });
  const response = await harness.send({ type: 'NAVA_SUBMIT_STATUS', routePolicy: routePolicy(url) });
  assert.deepEqual(JSON.parse(JSON.stringify(response)), { ok: false, error: 'Unknown message.' });

  const scan = await harness.send({ type: 'NAVA_SCAN', participant: {}, routePolicy: routePolicy(url) });
  assert.equal(scan.submitGate.found, true);
  assert.match(agentSource, /return \{ ok: true, \.\.\.advance\(\) \};/);
});

test('human checkpoints outrank final-review signals and an authorized continuation', async () => {
  const url = 'https://benefitscal.com/ApplyForBenefits/ABNMI';
  const oneTimeCode = mockField({ id: 'otp', name: 'otp', label: 'Verification code', autocomplete: 'one-time-code' });
  const next = control('Next', ['button[name="common_continue"]']);
  const finalHeading = visibleNode('Review and submit');

  const blocked = agentHarness(url, { controls: [next], headings: [finalHeading], fields: [oneTimeCode] });
  const otpResponse = await blocked.send({ type: 'NAVA_ADVANCE', routePolicy: routePolicy(url) });
  assert.equal(otpResponse.advanced, false);
  assert.equal(otpResponse.navigationGate.kind, 'manual');
  assert.match(otpResponse.navigationGate.reason, /one-time code/);
  assert.equal(next.clicked, false);

  const captcha = agentHarness(url, { controls: [next], headings: [finalHeading], botWidget: {} });
  const captchaGate = (await captcha.send({ type: 'NAVA_NAVIGATION_STATUS', routePolicy: routePolicy(url) })).navigationGate;
  assert.equal(captchaGate.kind, 'manual');
  assert.match(captchaGate.reason, /bot check before the assistant can continue/);

  const finalOnly = agentHarness(url, { controls: [next], headings: [finalHeading] });
  const finalGate = (await finalOnly.send({ type: 'NAVA_NAVIGATION_STATUS', routePolicy: routePolicy(url) })).navigationGate;
  assert.equal(finalGate.kind, 'final_review');
  assert.equal(finalGate.text, '');
});

test('describe-field skip path omits unavailable, credential, payment, attestation, and decoy controls', () => {
  const fields = [
    mockField({ id: 'first', name: 'first', label: 'First name' }),
    mockField({ id: 'hiddenField', name: 'hiddenField', label: 'Shown later', hidden: true }),
    mockField({ id: 'disabledField', name: 'disabledField', label: 'Disabled', disabled: true }),
    mockField({ type: 'hidden', id: 'token', name: 'token', label: 'Token' }),
    mockField({ type: 'submit', id: 'go', name: 'go', label: 'Go' }),
    mockField({ type: 'file', id: 'upload', name: 'upload', label: 'Upload' }),
    mockField({ type: 'password', id: 'pw', name: 'pw', label: 'Password' }),
    mockField({ type: 'password', id: 'ssnPw', name: 'ssnPw', label: 'Social Security Number' }),
    mockField({ id: 'cardNo', name: 'cardNo', label: 'Card', autocomplete: 'cc-number' }),
    mockField({ id: 'routing', name: 'routing', label: 'Routing number' }),
    mockField({ type: 'checkbox', id: 'certify', name: 'certify', label: 'I certify under penalty of perjury' }),
    mockField({ id: 'hp', name: 'hp', label: 'Leave this field blank' }),
    mockField({ id: 'find', name: 'find', label: 'Find', searchRoot: {} }),
  ];
  const descriptions = scanHarness('https://example.gov/application', { fields, adapter: null }).scanFields();

  assert.deepEqual(JSON.parse(JSON.stringify(descriptions.map((field) => field.id))), ['first', 'ssnPw']);
  assert.equal(descriptions[1].sensitive, true, 'a password-masked SSN stays in scope as a sensitive field');
});

test('describe-field site-policy path: adapter ignore drops a control and adapter values override inferred ones', () => {
  const seen = [];
  const adapter = {
    fieldPolicy(hostname, pathname, field) {
      seen.push({ hostname, pathname, field });
      if (field.id === 'skip') return { ignore: true };
      if (field.id === 'choice') {
        return {
          question: '  Adapter   question ',
          type: 'radio',
          purpose: 'adapterPurpose',
          decisionGroupKey: 'decision:1',
          decisionGroupQuestion: ' Pick   one ',
          unmapped: true,
          allowRepeatedPurpose: true,
          exclusive: true,
          required: true,
          sensitive: true,
          groupKey: 'adapter:group',
          optionValue: 0,
        };
      }
      return null;
    },
  };
  const fields = [
    mockField({ id: 'skip', name: 'skip', label: 'Skipped' }),
    mockField({ type: 'checkbox', id: 'choice', name: 'choice', value: 'on', label: 'Choice', className: 'a b' }),
    Object.assign(mockField({ id: 'plain', name: 'plain', value: 'v', label: 'Plain' }), { className: {} }),
  ];
  const harness = scanHarness('https://example.gov/apply', { fields, adapter });
  const descriptions = harness.scanFields();

  assert.deepEqual(JSON.parse(JSON.stringify(descriptions.map((field) => field.id))), ['choice', 'plain']);
  const choice = descriptions[0];
  assert.equal(choice.question, 'Adapter question');
  assert.equal(choice.type, 'radio');
  assert.equal(choice.purpose, 'adapterPurpose');
  assert.equal(choice.decisionGroupKey, 'decision:1');
  assert.equal(choice.decisionGroupQuestion, 'Pick one');
  assert.equal(choice.unmapped, true);
  assert.equal(choice.allowRepeatedPurpose, true);
  assert.equal(choice.exclusive, true);
  assert.equal(choice.required, true);
  assert.equal(choice.sensitive, true);
  assert.equal(choice.groupKey, 'adapter:group');
  assert.equal(choice.optionValue, '0');
  const [member] = harness.groupMap.get('adapter:group');
  assert.equal(member.optionValue, '0');
  assert.equal(member.exclusive, true);

  assert.deepEqual(JSON.parse(JSON.stringify(seen.find((call) => call.field.id === 'plain'))), {
    hostname: 'example.gov',
    pathname: '/apply',
    field: { id: 'plain', name: 'plain', value: 'v', className: '', type: 'text', label: 'Plain', question: '' },
  });
  assert.equal(seen.find((call) => call.field.id === 'choice').field.className, 'a b');
  const plain = descriptions[1];
  assert.equal(plain.purpose, '');
  assert.equal(plain.groupKey, '');
  assert.equal(plain.exclusive, false);
});

test('describe-field label path prefers label[for], aria-label, aria-labelledby, placeholder, name, then id', () => {
  const fields = [
    mockField({ id: 'associated', name: 'associated', label: 'Aria loses' }),
    mockField({ id: 'aria', name: 'aria', label: 'Aria label' }),
    mockField({ id: 'labelled', name: 'labelled', attributes: { 'aria-labelledby': 'part-a part-b' } }),
    mockField({ id: 'hinted', name: 'hinted', placeholder: 'MM/DD/YYYY' }),
    mockField({ id: 'named', name: 'applicant_middle' }),
    mockField({ id: 'only-id' }),
    mockField({}),
  ];
  const descriptions = scanHarness('https://example.gov/application', {
    fields,
    labels: { associated: { textContent: '  Associated \n label ' } },
    nodes: { 'part-a': { textContent: 'Household' }, 'part-b': { textContent: ' size ' } },
    adapter: null,
  }).scanFields();

  assert.deepEqual(JSON.parse(JSON.stringify(descriptions.map((field) => field.label))), [
    'Associated label',
    'Aria label',
    'Household size',
    'MM/DD/YYYY',
    'applicant_middle',
    'only-id',
    'Unlabeled field',
  ]);
  assert.ok(descriptions.every((field) => field.optionLabel === field.label));
});

test('describe-field question and group keys cover named, nameless, and lone choice controls', () => {
  const legend = (text) => ({ textContent: text, className: '', getAttribute() { return ''; } });
  const fieldset = (text) => {
    const heading = legend(text);
    return { textContent: '', className: '', getAttribute() { return ''; }, querySelector() { return heading; } };
  };
  const housing = fieldset('Is the client experiencing homelessness?');
  const rent = fieldset('Does the client rent?');
  const fields = [
    mockField({ type: 'radio', id: 'housing-yes', name: 'housing', value: 'yes', label: 'Yes', group: housing }),
    mockField({ type: 'radio', id: 'housing-no', name: 'housing', value: 'no', label: 'No', group: housing }),
    mockField({ type: 'checkbox', id: 'rent-yes', value: 'Yes', label: 'Yes', group: rent }),
    mockField({ type: 'checkbox', id: 'rent-no', value: 'No', label: 'No', group: rent }),
    mockField({ type: 'radio', id: 'lone', value: 'solo', label: 'Lone option' }),
    mockField({ id: 'notes', name: 'notes', label: 'Notes', group: housing }),
  ];
  const harness = scanHarness('https://example.gov/application', { fields, adapter: null });
  const byId = Object.fromEntries(harness.scanFields().map((field) => [field.id, field]));

  assert.equal(byId['housing-yes'].groupKey, 'group:radio:housing');
  assert.equal(byId['housing-no'].groupKey, 'group:radio:housing');
  assert.equal(byId['housing-yes'].question, 'Is the client experiencing homelessness?');
  assert.equal(byId['rent-yes'].groupKey, 'group:checkbox:does the client rent?');
  assert.equal(byId['rent-no'].groupKey, byId['rent-yes'].groupKey);
  assert.equal(byId.lone.groupKey, '', 'a nameless radio with no sibling question is not a group');
  assert.equal(byId.lone.question, '');
  assert.equal(byId.notes.question, '', 'only choice controls inherit a group question');
  assert.equal(byId.notes.groupKey, '');

  const members = harness.groupMap.get('group:radio:housing');
  assert.deepEqual(JSON.parse(JSON.stringify(members.map((member) => [member.fieldKey, member.optionLabel, member.optionValue, member.exclusive]))), [
    [byId['housing-yes'].fieldKey, 'Yes', 'yes', false],
    [byId['housing-no'].fieldKey, 'No', 'no', false],
  ]);
  assert.equal(harness.groupMap.get('group:checkbox:does the client rent?').length, 2);
  assert.equal(harness.groupMap.has(''), false);
  assert.equal(harness.fieldMap.size, 6);
});

test('describe-field required and sensitive flags come from the element, its label, and its signals', () => {
  const fields = [
    mockField({ id: 'requiredAttr', name: 'requiredAttr', label: 'Last name', required: true }),
    mockField({ id: 'ariaRequired', name: 'ariaRequired', label: 'City', attributes: { 'aria-required': 'true' } }),
    mockField({ id: 'starred', name: 'starred', label: 'Email *' }),
    mockField({ id: 'optional', name: 'optional', label: 'Middle name' }),
    mockField({ id: 'ssn', name: 'ssn', label: 'Social Security Number' }),
    mockField({ id: 'ein', name: 'ein', label: 'Tax' }),
    mockField({ id: 'phone', name: 'phone', label: 'Phone' }),
  ];
  const byId = Object.fromEntries(scanHarness('https://example.gov/application', { fields, adapter: null })
    .scanFields()
    .map((field) => [field.id, field]));

  assert.deepEqual(
    ['requiredAttr', 'ariaRequired', 'starred', 'optional'].map((id) => byId[id].required),
    [true, true, true, false],
  );
  assert.deepEqual(['ssn', 'ein', 'phone'].map((id) => byId[id].sensitive), [true, true, false]);
});

test('describe-field current-value path reports text, choice, and constraint state', () => {
  const fields = [
    mockField({ id: 'name', name: 'name', value: 'Ada', label: 'Name', maxLength: 5, autocomplete: 'given-name', placeholder: 'Given name' }),
    mockField({ id: 'free', name: 'free', label: 'Notes' }),
    mockField({ type: 'checkbox', id: 'texts', name: 'texts', value: 'on', label: 'Texts', checked: true }),
    mockField({ type: 'checkbox', id: 'mail', name: 'mail', value: 'on', label: 'Mail' }),
  ];
  const byId = Object.fromEntries(scanHarness('https://example.gov/application', { fields, adapter: null })
    .scanFields()
    .map((field) => [field.id, field]));

  assert.deepEqual(
    JSON.parse(JSON.stringify([byId.name.value, byId.name.maxLength, byId.name.autocomplete, byId.name.placeholder, byId.name.optionValue, byId.name.options])),
    ['Ada', 5, 'given-name', 'Given name', '', []],
  );
  assert.equal(byId.free.maxLength, null);
  assert.equal(byId.free.tag, 'input');
  assert.equal(byId.free.type, 'text');
  assert.deepEqual([byId.texts.checked, byId.texts.value, byId.texts.optionValue], [true, 'on', 'on']);
  assert.deepEqual([byId.mail.checked, byId.mail.value, byId.mail.optionValue], [false, '', 'on']);
});

test('scanned field descriptions keep their published wire-format key order', () => {
  const [description] = scanHarness('https://example.gov/application', {
    fields: [mockField({ id: 'name', name: 'name', label: 'Name' })],
    adapter: null,
  }).scanFields();

  assert.deepEqual(Object.keys(description), [
    'fieldKey', 'groupKey', 'tag', 'type', 'id', 'name', 'label', 'optionLabel', 'question',
    'purpose', 'decisionGroupKey', 'decisionGroupQuestion', 'unmapped', 'allowRepeatedPurpose', 'exclusive',
    'placeholder', 'autocomplete', 'pattern', 'maxLength', 'required', 'disabled', 'visible',
    'checked', 'value', 'optionValue', 'options', 'sensitive',
  ]);
});

test('value writer strategies write, read back, and verify through the real fill path', { concurrency: true }, async (t) => {
  const url = 'https://example.gov/application';
  const assignment = (fieldKey, value, label = 'Fixture') => ({
    fieldKey,
    label,
    value,
    source: 'test record',
    detail: 'Writer strategy fixture',
    sensitive: false,
  });

  await Promise.all([
    t.test('choice group: an inclusive checkbox group checks only the chosen box', async () => {
      const harness = fillHarness(url, { adapter: null });
      const meals = harness.input({ id: 'meals', name: 'services', label: 'Meals', type: 'checkbox', value: 'meals' });
      const rides = harness.input({ id: 'rides', name: 'services', label: 'Rides', type: 'checkbox', value: 'rides' });
      const care = harness.input({ id: 'care', name: 'services', label: 'Care', type: 'checkbox', value: 'care' });
      meals.checked = true;
      harness.scan();
      const response = await harness.fillAssignments([assignment('group:checkbox:services', 'Rides')]);

      assert.equal(response.results[0].status, 'verified');
      assert.deepEqual([meals.checked, rides.checked, care.checked], [true, true, false]);
    }),

    t.test('single checkbox: a lone checkbox takes the requested checked state and reports yes/no', async () => {
      const harness = fillHarness(url, { adapter: null });
      const reminders = harness.input({ id: 'reminders', name: '', label: 'Send reminders', type: 'checkbox', value: '' });
      const [description] = harness.scan();
      assert.equal(description.groupKey, '');

      const checkedResponse = await harness.fillAssignments([assignment(description.fieldKey, 'yes')]);
      assert.equal(checkedResponse.results[0].status, 'verified');
      assert.equal(checkedResponse.results[0].actual, 'yes');
      assert.equal(reminders.checked, true);

      const clearedResponse = await harness.fillAssignments([assignment(description.fieldKey, 'no')]);
      assert.equal(clearedResponse.results[0].status, 'verified');
      assert.equal(clearedResponse.results[0].actual, 'no');
      assert.equal(reminders.checked, false);
    }),

    t.test('native select: the matched option value is written; an unmatched answer is refused before any event', async () => {
      const harness = fillHarness(url, { adapter: null });
      const language = harness.select({
        id: 'language',
        label: 'Language',
        options: [['', 'Select one'], ['en', 'English'], ['es', 'Spanish']],
      });
      const [description] = harness.scan();
      assert.deepEqual(JSON.parse(JSON.stringify(description.options)), [
        { value: 'en', label: 'English' },
        { value: 'es', label: 'Spanish' },
      ]);

      const refused = await harness.fillAssignments([assignment(description.fieldKey, 'Klingon')]);
      assert.equal(refused.results[0].status, 'blocked');
      assert.equal(refused.results[0].reason, 'The answer does not match one of the choices on the form.');
      assert.deepEqual(language.events, []);
      assert.equal(language.value, '');

      const written = await harness.fillAssignments([assignment(description.fieldKey, 'es')]);
      assert.equal(written.results[0].status, 'verified');
      assert.equal(written.results[0].actual, 'es');
      assert.deepEqual(language.events, ['input', 'change']);
    }),

    t.test('Select2: verification requires the widget to render the selected option', async () => {
      const select2 = (initial) => {
        const rendered = { textContent: initial };
        return {
          rendered,
          matches(selector) { return selector.includes('.select2'); },
          querySelector(selector) { return selector === '.select2-selection__rendered' ? rendered : null; },
          getBoundingClientRect() { return { width: 240, height: 36 }; },
        };
      };
      const options = [['SEL', '-Select One-'], ['H', 'Hispanic or Latino'], ['N', 'Not Hispanic or Latino']];
      const harness = fillHarness(url, { adapter: null });
      const liveWidget = select2('-Select One-');
      const live = harness.select({ id: 'ethnicity', label: 'Ethnicity', value: 'SEL', options, select2: liveWidget });
      const staleWidget = select2('-Select One-');
      harness.select({ id: 'race', label: 'Race', value: 'SEL', options, select2: staleWidget });
      const dispatch = live.dispatchEvent.bind(live);
      live.dispatchEvent = (event) => {
        if (event.type === 'change') {
          liveWidget.rendered.textContent = live.options.find((option) => option.value === live.value).textContent;
        }
        return dispatch(event);
      };
      const [ethnicity, race] = harness.scan();
      const response = await harness.fillAssignments([
        assignment(ethnicity.fieldKey, 'N'),
        assignment(race.fieldKey, 'N'),
      ]);

      assert.equal(response.results[0].status, 'verified');
      assert.equal(response.results[1].status, 'blocked');
      assert.equal(response.results[1].actual, 'N', 'the native value was written but the widget never showed it');
      assert.equal(
        response.results[1].reason,
        'The form did not keep the value after two verified write methods. Enter this field directly.',
        'the stale widget is rejected at write time, not only by page-level revalidation',
      );
    }),

    t.test('masked text: a rejected bulk value is retried keystroke by keystroke in the original event order', async () => {
      const harness = fillHarness(url, { adapter: null });
      const phone = harness.input({ id: 'phone', label: 'Phone' });
      const events = [];
      const dispatch = phone.dispatchEvent.bind(phone);
      phone.dispatchEvent = (event) => {
        events.push(event.type === 'keydown' || event.type === 'keyup' ? `${event.type}:${event.key}` : event.inputType ? `${event.type}:${event.inputType}:${event.data}` : event.type);
        if (event.type === 'input' && !event.inputType) phone.value = '';
        return dispatch(event);
      };
      phone.setRangeText = function setRangeText(text, start, end) {
        this.value = `${this.value.slice(0, start)}${text}${this.value.slice(end)}`;
      };
      const [description] = harness.scan();
      const response = await harness.fillAssignments([assignment(description.fieldKey, '5551234567', 'Phone')]);

      assert.equal(response.results[0].status, 'verified');
      assert.equal(phone.value, '5551234567');
      const keystrokes = [...'5551234567'].flatMap((digit) => [
        `keydown:${digit}`,
        `beforeinput:insertText:${digit}`,
        `input:insertText:${digit}`,
        `keyup:${digit}`,
      ]);
      assert.deepEqual(events, ['input', 'change', 'input', 'change', ...keystrokes, 'change']);
    }),

    t.test('plain value: a radio outside any group is written natively, never typed into, and not claimed', async () => {
      const harness = fillHarness(url, { adapter: null });
      const lone = harness.input({ id: 'lone', name: '', label: 'Lone option', type: 'radio', value: 'solo' });
      const events = [];
      const dispatch = lone.dispatchEvent.bind(lone);
      lone.dispatchEvent = (event) => {
        events.push(event.type);
        return dispatch(event);
      };
      const [description] = harness.scan();
      assert.equal(description.groupKey, '');
      const response = await harness.fillAssignments([assignment(description.fieldKey, 'solo')]);

      assert.equal(response.results[0].status, 'blocked');
      assert.match(response.results[0].reason, /two verified write methods/);
      assert.deepEqual(events, ['input', 'change']);
    }),
  ]);
});
