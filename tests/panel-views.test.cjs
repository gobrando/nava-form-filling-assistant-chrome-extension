const test = require('node:test');
const assert = require('node:assert/strict');

const format = require('../sidepanel/panel-format.js');
const intakeViews = require('../sidepanel/view-intake.js');
const connectorViews = require('../sidepanel/view-connector.js');
const recertificationViews = require('../sidepanel/view-recertification.js');
const applicationViews = require('../sidepanel/view-applications.js');
const reviewViews = require('../sidepanel/view-review.js');
const engine = require('../shared/form-engine.js');
const connectorEngine = require('../shared/connector-engine.js');
const recertificationEngine = require('../shared/recertification-engine.js');
const programCatalog = require('../shared/program-catalog.js');

/** Composes every screen module the way sidepanel.js does, over a fake screen root. */
function screens({ state: stateOverrides = {}, previewMode = false, running = [], agentPlanner = null } = {}) {
  const state = {
    view: 'dashboard',
    error: '',
    participant: null,
    apps: [],
    currentAppId: null,
    handoffApplicationId: null,
    connector: null,
    connectorDraft: null,
    connectorSchema: [],
    pendingConnectorRecord: null,
    documentResult: null,
    activeTab: null,
    agentRuntime: { status: 'checking', message: '' },
    agentProvider: { kind: 'chrome-local' },
    plannerBase: '',
    recertifications: [],
    currentRecertificationId: '',
    recertificationSource: '',
    ...stateOverrides,
  };
  const appRoot = { innerHTML: '' };
  const renderError = () => (state.error ? `<div class="notice error">${format.escapeHtml(state.error)}</div>` : '');
  const clientSummary = () => engine.canonicalizeParticipant(state.participant || {});
  const managedConnector = () => state.connector?.mode === 'managed';
  const base = { state, appRoot, format, renderError };
  let intake = null;
  const connector = connectorViews.create({ ...base, previewMode, connectorEngine, managedConnector, renderRecordId: () => intake.renderRecordId() });
  intake = intakeViews.create({
    ...base,
    previewMode,
    engine,
    agentPlanner,
    programCatalog,
    clientSummary,
    managedConnector,
    renderConnectorStatus: connector.renderConnectorStatus,
    connectorTitle: connector.connectorTitle,
    connectorProvider: connector.connectorProvider,
    connectorSourceId: connector.connectorSourceId,
  });
  const applications = applicationViews.create({
    ...base,
    isRunning: (id) => running.includes(id),
    renderAgentRuntime: intake.renderAgentRuntime,
    firstName: () => clientSummary().values.firstName || 'Client',
  });
  const recertifications = recertificationViews.create({
    ...base,
    recertificationEngine,
    recertificationById: (id = state.currentRecertificationId) => state.recertifications.find((item) => item.id === id) || null,
  });
  const review = reviewViews.create({ ...base, renderDashboard: applications.renderDashboard });
  return { state, appRoot, ...connector, ...intake, ...applications, ...recertifications, ...review };
}

const actionsOf = (html) => [...html.matchAll(/data-action="([^"]+)"/g)].map((match) => match[1]);

test('CAPTCHA and one-time-code checkpoints offer a human-complete-and-resume action', () => {
  const view = screens();
  const captcha = view.applicationCard({ id: 'workflow:a b', name: 'App', url: 'https://site.example/', status: 'needs_attention', tabId: 4, checkpoint: { kind: 'captcha', label: 'Human bot check required' } });
  assert.match(captcha, /data-action="resume-human-checkpoint" data-app="workflow%3Aa%20b">I completed the CAPTCHA — resume</);
  assert.match(captcha, /Checkpoint:<\/strong> Human bot check required/);

  const otp = view.applicationCard({ id: 'b', status: 'needs_attention', tabId: 4, checkpoint: { kind: 'otp', label: 'Code' } });
  assert.match(otp, /I completed the one-time code — resume/);

  const detached = view.applicationCard({ id: 'c', status: 'needs_attention', checkpoint: { kind: 'captcha', label: 'Code' } });
  assert.doesNotMatch(detached, /resume-human-checkpoint/);

  const runningView = screens({ running: ['d'] });
  const busy = runningView.applicationCard({ id: 'd', status: 'needs_attention', tabId: 4, runProgress: 'Filling page 2…', checkpoint: { kind: 'captcha', label: 'x' } });
  assert.deepEqual(actionsOf(busy), ['open-handoff', 'go-tab']);
  assert.match(busy, /Running automatically\.<\/strong> Filling page 2…/);
});

test('expired sources reload client data and pending handoffs must be accepted', () => {
  const view = screens();
  const expired = view.applicationCard({ id: 'e', status: 'source_expired', tabId: 4 });
  assert.deepEqual(actionsOf(expired), ['reload-source', 'go-tab']);
  assert.match(expired, /Reload source data\./);

  const handoff = view.applicationCard({ id: 'h&1', status: 'handoff_pending', owner: { state: 'pending', assignedTo: '<Intake>' } });
  assert.deepEqual(actionsOf(handoff), ['accept-handoff']);
  assert.match(handoff, /data-app="h%261"/);
  assert.match(handoff, /Assigned to &lt;Intake&gt;/);

  const gaps = view.applicationCard({ id: 'g', status: 'needs_attention', analysis: { gaps: [{}, {}] } });
  assert.deepEqual(actionsOf(gaps), ['answer-run', 'answer', 'open-handoff']);
  assert.match(gaps, /2 answers are needed before this page is complete/);

  const fill = view.applicationCard({ id: 'f', status: 'ready_to_fill', tabId: 2, agentic: { approvedMappings: 1, provider: 'claude' } });
  assert.deepEqual(actionsOf(fill), ['run', 'fill', 'open-handoff', 'go-tab']);
  assert.match(fill, /AI-reviewed plan · 1 mapping · Claude mapper/);
});

test('the dashboard groups applications and the handoff form falls back when the application is gone', () => {
  const view = screens({ state: { participant: { firstName: 'Ana' }, apps: [{ id: 'r', name: 'Review me', status: 'ready_for_review' }] } });
  view.renderDashboard();
  assert.match(view.appRoot.innerHTML, /Ana's applications/);
  assert.match(view.appRoot.innerHTML, /READY FOR REVIEW/);
  assert.doesNotMatch(view.appRoot.innerHTML, /NEEDS YOUR ATTENTION/);

  view.state.handoffApplicationId = 'missing';
  view.renderHandoff();
  assert.equal(view.state.view, 'dashboard');
  view.state.handoffApplicationId = 'r';
  view.renderHandoff();
  assert.match(view.appRoot.innerHTML, /id="handoff-form"/);
  assert.match(view.appRoot.innerHTML, /Do not put client names, identifiers, or answers in the assignee field/);
});

test('the review screen escapes every filled value and always restates that the caseworker submits', () => {
  const application = {
    id: 'workflow:r',
    name: '<b>Benefits</b>',
    status: 'ready_for_review',
    provenance: [{ fieldKey: 'f', label: '<img src=x onerror=alert(1)>', value: '"><script>', source: 'record', detail: 'From <source>' }],
    empty: [{ label: 'Middle name' }],
    analysis: { noFields: [{ purpose: 'phone', label: 'Phone & text' }] },
  };
  const view = screens({ state: { apps: [application], currentAppId: 'workflow:r' } });
  view.renderReview();
  const html = view.appRoot.innerHTML;
  assert.doesNotMatch(html, /<script>|<img|<b>Benefits/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(html, /&quot;&gt;&lt;script&gt;/);
  assert.match(html, /title="From &lt;source&gt;"/);
  assert.match(html, /<td>\(empty\)<\/td>|>\(empty\)</);
  assert.match(html, /No matching field in this flow: Phone &amp; text\./);
  assert.match(html, /The assistant will not submit this application\. Review the page, complete any affirmation or bot check, and submit it yourself\./);
  assert.doesNotMatch(html, /data-action="submit/);

  application.runStopReason = 'Signature required <now>';
  view.renderReview();
  assert.match(view.appRoot.innerHTML, /Signature required &lt;now&gt;/);

  view.state.currentAppId = 'gone';
  view.renderReview();
  assert.equal(view.state.view, 'dashboard');
});

test('questions render choice, multi-choice with an explicit none option, and sensitive text inputs', () => {
  const gaps = [
    { fieldKey: 'm', question: 'Which apply?', inputType: 'multi_choice', options: [{ value: 'a', label: 'A' }, { optionLabel: 'B', value: 'b' }] },
    { fieldKey: 'c', question: 'Pick one', inputType: 'choice', kind: 'decision', options: [] },
    { fieldKey: 's', question: 'SSN?', inputType: 'text', sensitive: true, required: true },
  ];
  const view = screens({ state: { apps: [{ id: 'q', name: 'App', autoRun: true, analysis: { gaps } }], currentAppId: 'q' } });
  view.renderQuestions();
  const html = view.appRoot.innerHTML;
  assert.match(html, /type="checkbox" name="answer-0" value="__none__"/);
  assert.match(html, /type="radio" name="answer-1" value="yes"/);
  assert.match(html, /type="radio" name="answer-1" value="no"/);
  assert.match(html, /name="answer-2" autocomplete="off" inputmode="numeric"/);
  assert.match(html, /The form marks this as required/);
  assert.match(html, /Fill and continue automatically/);
  assert.deepEqual(view.choiceOptions({ options: [{ value: '' }, { label: 'Only label' }] }), [{ value: 'Only label', label: 'Only label' }]);
});

test('connector screens mark only the demo-tested adapter as available and review imported records', () => {
  const view = screens();
  view.renderProviderCatalog();
  const catalog = view.appRoot.innerHTML;
  assert.equal((catalog.match(/Fictional demo available/g) || []).length, 1);
  assert.equal((catalog.match(/Provisioned Nava adapter required/g) || []).length, connectorEngine.PROVIDER_CATALOG.length - 1);

  view.state.view = 'record-review';
  view.renderConnectorRecordReview();
  assert.equal(view.state.view, 'record');
  assert.match(view.appRoot.innerHTML, /id="record-form"/);

  view.state.pendingConnectorRecord = {
    record_id: '42',
    firstName: 'Ana',
    ssn: '111-22-3333',
    _connector: { organizationName: 'Org', freshness: 'unknown', provenance: { firstName: { sourceLabel: 'Given', sourceFieldId: '7' } } },
  };
  view.renderConnectorRecordReview();
  assert.match(view.appRoot.innerHTML, /Confirm this client/);
  assert.match(view.appRoot.innerHTML, /••••3333/);
  assert.doesNotMatch(view.appRoot.innerHTML, /111-22-3333/);
  assert.match(view.appRoot.innerHTML, /Source update time unavailable/);
});

test('document review never preselects low-confidence, OCR-review, or conflicting values', () => {
  const field = (key, value, extra = {}) => ({ key, value, label: key, displayValue: value, confidence: 'high', evidence: 'Label: value', ...extra });
  const view = screens({
    state: {
      participant: { firstName: 'Ana' },
      documentResult: {
        file: { name: 'scan.png' },
        quality: { method: 'ocr' },
        warnings: [],
        fields: [
          field('lastName', 'Diaz'),
          field('firstName', 'Anna'),
          field('email', 'a@b.example', { confidence: 'low' }),
          field('phone', '5550100', { reviewRequired: true, source: { method: 'ocr', pageNumber: 2, region: { x0: 1.2, y0: 2.6, x1: 30, y1: 40 } } }),
        ],
      },
    },
  });
  view.renderDocumentReview();
  const html = view.appRoot.innerHTML;
  const checked = [...html.matchAll(/name="fieldIndex" value="(\d)" (checked)?/g)].map((match) => Boolean(match[2]));
  assert.deepEqual(checked, [true, false, false, false]);
  assert.match(html, /Different from current:<\/strong> Ana\./);
  assert.match(html, /Page 2 · region 1,3–30,40/);
  assert.match(html, /On-device OCR · 4 proposed fields · 1 conflict · 1 low confidence/);
});

test('recertification preparation stays locked until data is current and the client authorizes it', () => {
  const [item] = recertificationEngine.normalizeCaseload([{
    id: 'r1', recordId: '1', displayName: 'Client One', programId: 'calfresh', programName: 'CalFresh', dueDate: '2099-01-01',
    requirements: { contact: { status: 'current' }, household: { status: 'missing' } },
  }]);
  const view = screens({ state: { recertifications: [item], currentRecertificationId: 'r1' } });
  view.renderRecertificationDetail();
  assert.match(view.appRoot.innerHTML, /The AI run stays locked until all information areas are current or confirmed/);
  assert.doesNotMatch(view.appRoot.innerHTML, /data-action="prepare-recertification"/);
  assert.match(view.recertificationCard(item), /data-action="review-recertification" data-recert="r1"/);

  view.state.currentRecertificationId = 'missing';
  view.renderRecertificationDetail();
  assert.equal(view.state.view, 'recertifications');
  assert.match(view.appRoot.innerHTML, /Client messages remain drafts until an authorized worker sends them/);
});

test('the model-runtime notice explains preview, unavailable, and companion states', () => {
  assert.match(screens({ previewMode: true }).renderAgentRuntime(), /Fixture preview\./);

  const unavailable = screens({ state: { agentRuntime: { status: 'unavailable', message: '' } } }).renderAgentRuntime();
  assert.match(unavailable, /class="notice error"/);
  assert.match(unavailable, /Chrome on-device AI unavailable\./);
  assert.match(unavailable, /data-action="enable-agent"/);
  assert.match(unavailable, /id="model-companion-fields" class="form-stack compact-form" hidden/);

  const companion = screens({
    state: { agentRuntime: { status: 'ready', shared: false }, agentProvider: { kind: 'local-cli', provider: 'codex', endpoint: 'http://127.0.0.1:9', token: 't"k' } },
    agentPlanner: { runtimeInfo: () => ({ title: 'Codex CLI', detail: 'Paired.' }) },
  }).renderAgentRuntime();
  assert.match(companion, /Codex CLI ready\.<\/strong> Paired\. The field mapper/);
  assert.doesNotMatch(companion, /enable-agent/);
  assert.match(companion, /<option value="codex" selected>/);
  assert.match(companion, /value="t&quot;k"/);
});

test('intake screens offer every client source and analyze only regular web pages', () => {
  const view = screens({ state: { activeTab: { url: 'chrome://extensions' }, participant: { firstName: 'Ana' } } });
  view.renderChoice();
  assert.deepEqual(actionsOf(view.appRoot.innerHTML).filter((action) => action.startsWith('choose-')), ['choose-id', 'choose-json', 'choose-document']);
  assert.match(view.appRoot.innerHTML, /data-action="configure-connector"/);

  view.renderPrograms();
  assert.match(view.appRoot.innerHTML, /value="current" disabled/);
  assert.equal((view.appRoot.innerHTML.match(/name="program" value="/g) || []).length, programCatalog.PROGRAMS.length + 1);

  view.state.activeTab = { url: 'https://www.forms.example/apply' };
  view.renderPrograms();
  assert.match(view.appRoot.innerHTML, /value="current" >/);
  assert.match(view.appRoot.innerHTML, /forms\.example/);
});
