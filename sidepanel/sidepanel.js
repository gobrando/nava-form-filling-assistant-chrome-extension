(function startSidePanel() {
  'use strict';

  const appRoot = document.getElementById('app');
  const engine = globalThis.NavaFormEngine;
  const connectorEngine = globalThis.NavaConnectorEngine;
  const workQueueEngine = globalThis.NavaWorkQueueEngine;
  const programCatalog = globalThis.NavaProgramCatalog;
  const previewMode = new URLSearchParams(location.search).get('preview') === '1'
    || !globalThis.chrome?.runtime?.id;
  const demoMode = new URLSearchParams(location.search).get('demo') === '1';
  const previewBanner = document.getElementById('preview-banner');
  if (previewBanner) previewBanner.hidden = !previewMode;

  const state = {
    view: 'choice',
    error: '',
    participant: null,
    documentResult: null,
    activeTab: null,
    apps: [],
    currentAppId: null,
    previewPage: 1,
    connector: null,
    connectorDraft: null,
    connectorSchema: [],
    pendingConnectorRecord: null,
    audit: [],
    handoffApplicationId: null,
    sessionEpoch: 0,
    participantSessionId: '',
    coordinatorRevision: 0,
    workerId: globalThis.crypto?.randomUUID?.() || `panel-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  };

  const MAX_AUTOMATED_PAGES = 60;
  const DEFAULT_AUTOMATED_PAGES = 12;
  const MAX_SAME_PAGE_FILL_PASSES = 3;
  const MAX_PARALLEL_APPLICATIONS = 3;
  const PAGE_AGENT_VERSION = 4;
  const TAB_READY_TIMEOUT_MS = 60_000;
  const NAVIGATION_TIMEOUT_MS = 60_000;
  const APPLICATION_LEASE_MS = 2 * 60 * 1000;
  const QUEUE_STORAGE_KEY = 'nava:work-queue';
  const COORDINATOR_STORAGE_KEY = 'nava:assistant-coordinator';
  const activeRunTokens = new Map();
  let sessionGeneration = 0;
  let uiGeneration = 0;
  let persistChain = Promise.resolve();
  let coordinatorMutationDepth = 0;
  let coordinatorSyncPending = false;
  let coordinatorSyncPromise = null;
  let pendingCoordinatorSnapshot = null;
  let automaticWorkersActive = 0;
  const pendingApplicationSyncIds = new Set();
  const leaseRetryTimers = new Map();
  const coordinatorRetryIds = new Set();
  const automaticRunQueue = [];
  const queuedAutomaticApplicationIds = new Set();

  const DEMO_RECORDS = {
    '339619': {
      record_id: '339619',
      participant: {
        name: { first: 'Celeste', middle: 'NAVA', last: 'Thomas', suffix: 'II' },
        date_of_birth: '2000-01-02',
        ethnicity: 'Hispanic/Latino',
        gender: 'Female',
        primary_language: 'English',
        special_needs: false,
        marital_status: 'Single parent household',
        farm_worker: false,
        pregnant: false,
        housing_status: 'Stable housing',
        ssn: '123-45-6789',
      },
      contact_information: {
        preferred_method: 'Email',
        phones: { cell: '777-777-7777' },
        email: 'testnava@email.com',
      },
      address: {
        residential: { street: '5556 Test Blvd', unit: 'Apt 556', city: 'WILDOMAR', state: 'California', county: 'Riverside', zip: '92595', country: 'United States' },
        mailing: { street: '5556 Test Blvd', unit: 'Apt 556', city: 'WILDOMAR', state: 'California', county: 'Riverside', zip: '92595', country: 'United States' },
      },
      householdSize: '3',
      immigrationStatus: 'U.S. citizen',
      income: '1850',
      childcare: true,
      unemployment: false,
      programData: {
        ihss: {
          applyingForSelf: true,
          adoptedMinorChild: false,
          genderIdentity: 'Decline to state',
          birthSex: 'Female',
          sexualOrientation: 'Decline to state',
          veteran: false,
          receivesSsi: false,
          homeAssistanceAvailable: false,
          livesAlone: false,
          householdReceivesServices: false,
          householdMembers: [{
            relationship: 'Child',
            name: 'Jordan Testchild',
            dateOfBirth: '2018-06-15',
            ssn: '987-65-4321',
          }],
          livingArrangement: 'Independent Living',
          blind: false,
          visuallyImpaired: false,
          healthHistory: 'Needs help with bathing, dressing, meal preparation, and transportation.',
          dailyLivingLimitations: true,
          hospiceCare: false,
          terminalIllness: false,
          organTransplant: false,
          supplementalOxygen: false,
          cancerTreatment: false,
          domesticServices: true,
          personalCare: true,
          transportation: true,
          paramedicalCare: false,
          otherServices: false,
          pastIhss: false,
        },
        wic: {
          canReceiveTexts: true,
          mediCalCoverage: 'No',
          postpartum: false,
          breastfeedingInfant: false,
          formulaInfant: false,
          childUnderFive: true,
          appointmentInPerson: true,
          appointmentPhone: false,
          appointmentVideo: false,
          clinic: 'Temecula WIC',
        },
      },
    },
  };

  const PREVIEW_CONNECTOR_SCHEMA = [
    { id: 101, label: 'First Name', type: 'text', reference_tag: 'firstName' },
    { id: 102, label: 'Middle Name', type: 'text', reference_tag: 'middleName' },
    { id: 103, label: 'Last Name', type: 'text', reference_tag: 'lastName' },
    { id: 104, label: 'Date of Birth', type: 'date', reference_tag: 'dateOfBirth' },
    { id: 105, label: 'Primary Email', type: 'email', reference_tag: 'email' },
    { id: 106, label: 'Cell Phone', type: 'phone', reference_tag: 'phone' },
    { id: 107, label: 'Residential Address', type: 'text', reference_tag: 'addressLine1' },
    { id: 108, label: 'Apartment or Unit', type: 'text', reference_tag: 'addressLine2' },
    { id: 109, label: 'Residential City', type: 'text', reference_tag: 'city' },
    { id: 110, label: 'Residential State', type: 'text', reference_tag: 'state' },
    { id: 111, label: 'Residential County', type: 'text', reference_tag: 'county' },
    { id: 112, label: 'ZIP Code', type: 'text', reference_tag: 'postalCode' },
    { id: 113, label: 'Preferred Language', type: 'select', reference_tag: 'primaryLanguage' },
    { id: 114, label: 'Gender', type: 'select', reference_tag: 'gender' },
    { id: 115, label: 'Ethnicity', type: 'select', reference_tag: 'ethnicity' },
    { id: 116, label: 'Marital Status', type: 'select', reference_tag: 'maritalStatus' },
    { id: 117, label: 'Special Needs', type: 'boolean', reference_tag: 'specialNeeds' },
    { id: 118, label: 'Farm Worker', type: 'boolean', reference_tag: 'farmWorker' },
    { id: 119, label: 'Preferred Contact Method', type: 'select', reference_tag: 'preferredContact' },
    { id: 120, label: 'Housing Status', type: 'select', reference_tag: 'housingStatus' },
    { id: 121, label: 'Household Size', type: 'number', reference_tag: 'householdSize' },
    { id: 122, label: 'Citizenship Status', type: 'select', reference_tag: 'immigrationStatus' },
    { id: 123, label: 'Monthly Household Income', type: 'currency', reference_tag: 'income' },
    { id: 124, label: 'Pays for Childcare', type: 'boolean', reference_tag: 'childcare' },
    { id: 125, label: 'Receives Unemployment Benefits', type: 'boolean', reference_tag: 'unemployment' },
    { id: 126, label: 'Pregnancy Status', type: 'boolean', reference_tag: 'pregnant' },
    { id: 127, label: 'Social Security Number', type: 'sensitive', reference_tag: 'ssn' },
    { id: 128, label: 'Residential Country', type: 'text', reference_tag: 'country' },
  ];

  const PREVIEW_RAW_RECORD = {
    data: [{
      id: 339619,
      attributes: {
        form_id: 99,
        mod_time: new Date().toISOString(),
        field_101: 'Celeste',
        field_102: 'NAVA',
        field_103: 'Thomas II',
        field_104: '2000-01-02',
        field_105: 'testnava@email.com',
        field_106: '777-777-7777',
        field_107: '5556 Test Blvd',
        field_108: 'Apt 556',
        field_109: 'WILDOMAR',
        field_110: 'California',
        field_111: 'Riverside',
        field_112: '92595',
        field_113: 'English',
        field_114: 'Female',
        field_115: 'Hispanic/Latino',
        field_116: 'Single',
        field_117: false,
        field_118: false,
        field_119: 'Email',
        field_120: 'Stable housing',
        field_121: '3',
        field_122: 'U.S. citizen',
        field_123: '1850',
        field_124: true,
        field_125: false,
        field_126: false,
        field_127: '123-45-6789',
        field_128: 'United States',
      },
    }],
  };

  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function encoded(value) {
    return encodeURIComponent(String(value));
  }

  function decoded(value) {
    return decodeURIComponent(String(value));
  }

  function sameValue(left, right) {
    return engine.normalize(left) === engine.normalize(right);
  }

  function displayValue(key, value) {
    if (['ssn', 'ein'].includes(key)) {
      const digits = String(value ?? '').replace(/\D/g, '');
      return digits.length >= 4 ? `••••${digits.slice(-4)}` : '••••';
    }
    return String(value ?? '');
  }

  function mergeVerifiedProvenance(...collections) {
    const byField = new Map();
    collections.flat().filter(Boolean).forEach((item) => {
      if (!item?.fieldKey) return;
      const normalized = { ...item };
      if (normalized.sensitive) {
        const digits = String(normalized.value ?? '').replace(/\D/g, '');
        normalized.value = digits.length >= 4 ? `••••${digits.slice(-4)}` : '••••';
      }
      delete normalized.sensitive;
      byField.set(normalized.fieldKey, normalized);
    });
    return [...byField.values()];
  }

  function provenanceForScan(previousProvenance, observed, preservePageProgress) {
    return mergeVerifiedProvenance(
      preservePageProgress ? (previousProvenance || []) : [],
      observed || [],
    );
  }

  function formatTimestamp(value) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? 'Unavailable' : date.toLocaleString();
  }

  function clientSummary() {
    return engine.canonicalizeParticipant(state.participant || {});
  }

  function firstName() {
    return clientSummary().values.firstName || clientSummary().name || 'Client';
  }

  function managedConnector() {
    return state.connector?.mode === 'managed';
  }

  function connectorTitle() {
    return managedConnector() ? state.connector.organizationName : 'Nava fictional test data';
  }

  function connectorProvider(config = state.connector) {
    return connectorEngine.providerDefinition(config?.provider) || connectorEngine.providerDefinition('apricot360');
  }

  function connectorSourceId(config = state.connector) {
    return String(config?.sourceId ?? config?.formId ?? '');
  }

  function providerInitials(name) {
    return (String(name).match(/[A-Za-z0-9]+/g) || [])
      .slice(0, 2)
      .map((word) => word[0])
      .join('')
      .toUpperCase();
  }

  function renderConnectorStatus() {
    const managed = managedConnector();
    const mapped = Object.keys(state.connector?.mappings || {}).length;
    return `
      <button class="connector-status ${managed ? 'connected' : ''}" type="button" data-action="configure-connector">
        <span class="connector-status-icon" aria-hidden="true">${managed ? '✓' : 'DB'}</span>
        <span><strong>${managed ? escapeHtml(connectorTitle()) : 'Connect an organization database'}</strong><small>${managed ? `${escapeHtml(connectorProvider().name)} · ${mapped} mapped fields · read-only` : 'Browse Apricot, Salesforce, HMIS, and other catalog sources'}</small></span>
        <span class="connector-status-action">${managed ? 'Manage' : 'Choose'} <span aria-hidden="true">›</span></span>
      </button>`;
  }

  function hostLabel(url) {
    try {
      return new URL(url).hostname.replace(/^www\./, '');
    } catch {
      return 'Current tab';
    }
  }

  async function getActiveTab() {
    if (previewMode) {
      return { id: 7001, title: 'Benefits application', url: `https://benefitscal.com/ApplyForBenefits/step-${state.previewPage}` };
    }
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab || null;
  }

  async function sendRuntime(message) {
    if (previewMode) return previewRuntime(message);
    return chrome.runtime.sendMessage(message);
  }

  async function requestAssistantState(
    send = sendRuntime,
    wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  ) {
    const delays = [0, 150, 500];
    let lastError = '';
    for (const delay of delays) {
      if (delay) await wait(delay);
      try {
        const response = await send({ type: 'GET_ASSISTANT_STATE' });
        if (response?.ok) return response;
        lastError = response?.error || '';
      } catch (error) {
        lastError = error?.message || String(error || '');
      }
    }
    if (lastError && !/extension context invalidated|receiving end does not exist|message port closed|could not establish connection/i.test(lastError)) {
      throw new Error(lastError);
    }
    throw new Error('The extension was reloaded safely. Close and reopen the side panel to reconnect. Saved application checkpoints remain available, but client data must be reloaded before filling resumes.');
  }

  async function probeTabDocument(tabId) {
    const [probe] = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [0] },
      func: () => ({ url: location.href, origin: location.origin, path: location.pathname }),
    });
    if (!probe?.documentId || !probe?.result?.url) {
      throw new Error('The application page changed before the assistant could bind to it. Try again after it finishes loading.');
    }
    return probe;
  }

  function assertSameDocumentLocation(expectedUrl, observedUrl) {
    if (commandLocation(expectedUrl) !== commandLocation(observedUrl)) {
      throw new Error('The browser tab navigated before the assistant could safely read or write it. Review the current page and try again.');
    }
  }

  async function ensurePageAgent(tab, documentId = null) {
    if (previewMode) return;
    if (!tab?.id || !/^https?:/i.test(tab.url || '')) {
      throw new Error('Open a regular website with a form, then try again. Chrome system pages cannot be filled.');
    }
    const messageOptions = documentId ? { documentId } : undefined;
    let pong = null;
    try {
      pong = await chrome.tabs.sendMessage(tab.id, { type: 'NAVA_PING' }, messageOptions);
    } catch {
      pong = null;
    }
    if (pong?.ok && pong.agentVersion === PAGE_AGENT_VERSION && pong.adaptersReady) return;
    try {
      await chrome.scripting.executeScript({
        target: documentId ? { tabId: tab.id, documentIds: [documentId] } : { tabId: tab.id },
        files: ['shared/form-engine.js', 'shared/site-adapters.js', 'content/form-agent.js'],
      });
      const verified = await chrome.tabs.sendMessage(tab.id, { type: 'NAVA_PING' }, messageOptions);
      if (verified?.ok && verified.agentVersion === PAGE_AGENT_VERSION && verified.adaptersReady) return;
    } catch {
      // The actionable error below covers stale and missing page agents.
    }
    throw new Error('This application tab still has an older form-filling agent. Refresh this tab once after reloading the extension, then scan it again. No form values were changed.');
  }

  async function sendToTab(tab, message, { application = null, requireLease = false } = {}) {
    if (previewMode) return previewTabMessage(message);
    const probe = await probeTabDocument(tab.id);
    assertSameDocumentLocation(tab.url, probe.result.url);
    if (application) assertApprovedApplicationLocation(application, probe.result.url);
    const boundTab = { ...tab, url: probe.result.url };
    await ensurePageAgent(boundTab, probe.documentId);
    const routePolicy = application ? {
      origins: application.allowedOrigins?.length ? application.allowedOrigins : [urlOrigin(application.url)],
      pathPrefixes: application.allowedPathPrefixes || [],
      expectedPath: urlPath(probe.result.url),
      expectedSearch: urlSearch(probe.result.url),
      expectedHash: urlHash(probe.result.url),
    } : {
      origins: [urlOrigin(probe.result.url)],
      exactPaths: [urlPath(probe.result.url)],
      expectedPath: urlPath(probe.result.url),
      expectedSearch: urlSearch(probe.result.url),
      expectedHash: urlHash(probe.result.url),
    };
    const command = { ...message, routePolicy };
    if (!application) {
      return chrome.tabs.sendMessage(tab.id, command, { documentId: probe.documentId });
    }
    const response = await sendRuntime({
      type: 'EXECUTE_APPLICATION_COMMAND',
      tabId: tab.id,
      documentId: probe.documentId,
      command,
      sessionEpoch: state.sessionEpoch,
      participantSessionId: state.participantSessionId,
      applicationId: application.id,
      applicationGeneration: Number(application.controlGeneration || 0),
      applicationRevision: Number(application.controlRevision || 0),
      holder: state.workerId,
      requireLease,
    });
    if (!response?.ok && response?.stale) {
      cancelApplicationRun(application);
      scheduleCoordinatorSync(application.id);
      throw coordinatorStaleError(response.error);
    }
    return response;
  }

  function runCancelledError() {
    const error = new Error('The automated run was stopped.');
    error.name = 'RunCancelledError';
    return error;
  }

  function coordinatorStaleError(message = 'This application run changed in another assistant window.') {
    const error = new Error(message);
    error.name = 'RunCancelledError';
    return error;
  }

  function leaseConflictError(message = 'Another assistant window is already working on this application.', lease = null) {
    const error = new Error(message);
    error.name = 'LeaseConflictError';
    error.lease = lease;
    return error;
  }

  function uiCancelledError() {
    const error = new Error('That screen was closed before the operation finished.');
    error.name = 'UiCancelledError';
    return error;
  }

  function cancelPendingUiWork() {
    uiGeneration += 1;
    return uiGeneration;
  }

  function assertUiGeneration(generation) {
    if (generation !== uiGeneration) throw uiCancelledError();
  }

  async function beginApplicationRun(application, { uiBound = false } = {}) {
    const requestedSessionGeneration = sessionGeneration;
    const requestedSessionEpoch = state.sessionEpoch;
    while (activeRunTokens.has(application.id)) {
      const existing = activeRunTokens.get(application.id);
      cancelApplicationRun(application);
      await existing.settled;
    }
    if (requestedSessionGeneration !== sessionGeneration
      || requestedSessionEpoch !== state.sessionEpoch
      || !state.apps.some((item) => item.id === application.id)) {
      throw runCancelledError();
    }
    let resolveSettled;
    const settled = new Promise((resolve) => { resolveSettled = resolve; });
    const token = {
      id: globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`,
      sessionGeneration,
      sessionEpoch: state.sessionEpoch,
      applicationGeneration: Number(application.controlGeneration || 0),
      uiBound,
      cancelled: false,
      settled,
      resolveSettled,
      settledResolved: false,
    };
    activeRunTokens.set(application.id, token);
    return token;
  }

  function assertApplicationRun(application, token) {
    if (!token) return;
    const current = activeRunTokens.get(application.id);
    if (token.cancelled
      || token.sessionGeneration !== sessionGeneration
      || token.sessionEpoch !== state.sessionEpoch
      || token.applicationGeneration !== Number(application.controlGeneration || 0)
      || current !== token
      || !state.apps.some((item) => item.id === application.id)) {
      throw runCancelledError();
    }
  }

  function endApplicationRun(application, token) {
    if (activeRunTokens.get(application.id) === token) activeRunTokens.delete(application.id);
    application.runProgress = '';
    if (!token.settledResolved) {
      token.settledResolved = true;
      token.resolveSettled();
    }
  }

  async function withNewApplicationRun(application, action, options = {}) {
    const requestedUiGeneration = uiGeneration;
    const token = await beginApplicationRun(application, options);
    if (options.uiBound && requestedUiGeneration !== uiGeneration) {
      cancelApplicationRun(application);
      endApplicationRun(application, token);
      throw uiCancelledError();
    }
    try {
      return await action(token);
    } finally {
      endApplicationRun(application, token);
    }
  }

  function cancelApplicationRun(application) {
    const token = activeRunTokens.get(application.id);
    if (token) token.cancelled = true;
    if (!previewMode && application.tabId && application.lease?.holder === state.workerId) {
      void chrome.tabs.sendMessage(application.tabId, { type: 'NAVA_CANCEL' }).catch(() => {});
    }
  }

  function cancelAllRuns() {
    sessionGeneration += 1;
    state.apps.forEach(cancelApplicationRun);
    leaseRetryTimers.forEach((timer) => clearTimeout(timer));
    leaseRetryTimers.clear();
    coordinatorRetryIds.clear();
    automaticRunQueue.splice(0);
    queuedAutomaticApplicationIds.clear();
  }

  async function cancelUiBoundRuns() {
    const applications = [];
    [...activeRunTokens.entries()].forEach(([applicationId, token]) => {
      if (!token.uiBound) return;
      const application = state.apps.find((item) => item.id === applicationId);
      if (application) {
        application.autoRun = false;
        cancelApplicationRun(application);
        applications.push(application);
      }
      else {
        token.cancelled = true;
      }
    });
    for (const application of applications) {
      await revokeApplicationRun(application);
      application.autoRun = false;
      application.status = 'paused';
      application.checkpoint = checkpoint('voluntary_pause', 'Paused when the assistant returned home');
      application.runStopReason = 'Paused when the assistant returned home.';
      application.updatedAt = new Date().toISOString();
    }
  }

  async function revokeApplicationRun(application) {
    cancelApplicationRun(application);
    if (previewMode) {
      application.controlGeneration = Number(application.controlGeneration || 0) + 1;
      return;
    }
    await persistChain.catch(() => {});
    await withCoordinatorMutation(async () => {
      const response = await sendRuntime({
        type: 'REVOKE_APPLICATION_RUN',
        sessionEpoch: state.sessionEpoch,
        participantSessionId: state.participantSessionId,
        applicationId: application.id,
        applicationGeneration: Number(application.controlGeneration || 0),
        applicationRevision: Number(application.controlRevision || 0),
      });
      if (!response?.ok) {
        scheduleCoordinatorSync(application.id);
        throw coordinatorStaleError(response?.error);
      }
      applyCoordinatorMetadata(response);
      application.controlGeneration = Number(response.applicationGeneration ?? application.controlGeneration ?? 0);
      application.controlRevision = Number(response.applicationRevision ?? application.controlRevision ?? 0);
    });
  }

  function applicationGenerations() {
    return Object.fromEntries(state.apps.map((application) => [application.id, Number(application.controlGeneration || 0)]));
  }

  function applicationRevisions() {
    return Object.fromEntries(state.apps.map((application) => [application.id, Number(application.controlRevision || 0)]));
  }

  function applyCoordinatorMetadata(response) {
    if (!response) return;
    if (Number.isSafeInteger(Number(response.sessionEpoch))) state.sessionEpoch = Number(response.sessionEpoch);
    if (typeof response.participantSessionId === 'string') state.participantSessionId = response.participantSessionId;
    if (Number.isSafeInteger(Number(response.stateRevision))) state.coordinatorRevision = Number(response.stateRevision);
    state.apps.forEach((application) => {
      if (Object.hasOwn(response.applicationGenerations || {}, application.id)) {
        application.controlGeneration = Number(response.applicationGenerations[application.id] || 0);
      }
      if (Object.hasOwn(response.applicationRevisions || {}, application.id)) {
        application.controlRevision = Number(response.applicationRevisions[application.id] || 0);
      }
    });
  }

  async function assertCoordinatorAuthorization(application, { requireLease = false } = {}) {
    if (previewMode || !application?.id) return;
    const response = await sendRuntime({
      type: 'CHECK_APPLICATION_RUN',
      sessionEpoch: state.sessionEpoch,
      participantSessionId: state.participantSessionId,
      applicationId: application.id,
      applicationGeneration: Number(application.controlGeneration || 0),
      applicationRevision: Number(application.controlRevision || 0),
      holder: state.workerId,
      requireLease,
    });
    if (!response?.ok || !response.allowed) {
      cancelApplicationRun(application);
      scheduleCoordinatorSync(application.id);
      throw coordinatorStaleError(response?.error);
    }
  }

  async function withCoordinatorMutation(action) {
    coordinatorMutationDepth += 1;
    try {
      return await action();
    } finally {
      coordinatorMutationDepth -= 1;
      if (coordinatorMutationDepth === 0 && pendingCoordinatorSnapshot) {
        const snapshot = pendingCoordinatorSnapshot;
        pendingCoordinatorSnapshot = null;
        observeCoordinator(snapshot);
      }
      if (coordinatorMutationDepth === 0 && (coordinatorSyncPending || pendingApplicationSyncIds.size)) {
        scheduleCoordinatorSync(coordinatorSyncPending ? null : []);
      }
    }
  }

  function newWorkflowId() {
    return `workflow:${globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;
  }

  function recordAudit(type, application, details = {}) {
    const event = workQueueEngine.auditEvent(type, application, details);
    state.audit = workQueueEngine.appendAudit(state.audit, event);
  }

  function markSourceReloaded() {
    state.apps.forEach((application) => {
      if (application.status !== 'source_expired') return;
      application.durableOnly = false;
      application.error = '';
      application.status = 'paused';
      application.checkpoint = {
        kind: 'voluntary_pause',
        label: 'Verify the saved page before resuming',
        createdAt: new Date().toISOString(),
      };
      application.updatedAt = new Date().toISOString();
      recordAudit('source_reloaded', application, { toStatus: 'paused' });
    });
  }

  function durableQueue(applicationIds = null) {
    const selectedIds = applicationIds === null ? null : new Set(applicationIds);
    const applications = selectedIds === null
      ? state.apps
      : state.apps.filter((application) => selectedIds.has(application.id));
    return workQueueEngine.buildQueue(applications, state.audit);
  }

  async function commitParticipant(participant) {
    if (previewMode) {
      state.participant = participant;
      markSourceReloaded();
      return;
    }
    await withCoordinatorMutation(async () => {
      const updating = Boolean(state.participant && state.participantSessionId);
      const response = await sendRuntime({
        type: updating ? 'UPDATE_SESSION_PARTICIPANT' : 'CLAIM_CLIENT_SESSION',
        sessionEpoch: state.sessionEpoch,
        participantSessionId: state.participantSessionId,
        stateRevision: state.coordinatorRevision,
        participant,
      });
      if (!response?.ok) {
        if (response?.stale || response?.code === 'PARTICIPANT_ALREADY_CLAIMED') scheduleCoordinatorSync();
        throw coordinatorStaleError(response?.error || 'Another assistant window changed the client session.');
      }
      applyCoordinatorMetadata(response);
      if (response.claimed) {
        state.apps.forEach((application) => {
          application.controlGeneration = 0;
          application.controlRevision = 0;
        });
      }
      if (response.revokedApplicationIds?.length) await restore({ preserveView: true });
      else state.participant = participant;
      markSourceReloaded();
    });
  }

  async function persist({ applicationIds = null, includeCurrentAppId = applicationIds === null } = {}) {
    if (previewMode) return;
    const write = persistChain.catch(() => {}).then(async () => {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        let retryAfterGlobalSync = false;
        await withCoordinatorMutation(async () => {
          const selectedIds = applicationIds === null ? null : new Set(applicationIds);
          const applications = selectedIds === null
            ? state.apps
            : state.apps.filter((application) => selectedIds.has(application.id));
          const sessionSnapshot = structuredClone({
            apps: applications,
            ...(includeCurrentAppId ? { currentAppId: state.currentAppId } : {}),
          });
          const queueSnapshot = durableQueue(applicationIds);
          const response = await sendRuntime({
            type: 'PERSIST_ASSISTANT_STATE',
            sessionEpoch: state.sessionEpoch,
            participantSessionId: state.participantSessionId,
            stateRevision: state.coordinatorRevision,
            applicationGenerations: applicationGenerations(),
            applicationRevisions: applicationRevisions(),
            workerId: state.workerId,
            holder: state.workerId,
            session: sessionSnapshot,
            queue: queueSnapshot,
          });
          if (!response?.ok) {
            if (response?.code === 'STALE_STATE_REVISION' && attempt === 0) {
              retryAfterGlobalSync = true;
              scheduleCoordinatorSync();
              return;
            }
            if (response?.stale) {
              applyCoordinatorMetadata(response);
              scheduleCoordinatorSync(response.applicationId || null);
              throw coordinatorStaleError(response?.error);
            }
            throw new Error(response?.error || 'The assistant could not save its current checkpoint.');
          }
          applyCoordinatorMetadata(response);
          if (response.rejectedApplicationIds?.length) {
            response.rejectedApplicationIds.forEach((id) => {
              const application = state.apps.find((item) => item.id === id);
              if (application) cancelApplicationRun(application);
            });
            scheduleCoordinatorSync(response.rejectedApplicationIds);
            throw coordinatorStaleError('An application was paused or changed in another assistant window.');
          }
        });
        if (!retryAfterGlobalSync) return;
        if (!coordinatorSyncPromise) scheduleCoordinatorSync();
        await waitForCoordinatorSync();
        if (attempt === 1) throw coordinatorStaleError('Assistant state kept changing while this checkpoint was being saved.');
      }
      throw coordinatorStaleError('Assistant state could not be reconciled before saving.');
    });
    persistChain = write;
    await write;
  }

  async function clearAssistantState() {
    if (previewMode) return;
    const clear = persistChain.catch(() => {}).then(async () => {
      await withCoordinatorMutation(async () => {
        const response = await sendRuntime({
          type: 'CLEAR_ASSISTANT_STATE',
          sessionEpoch: state.sessionEpoch,
        });
        if (!response?.ok) {
          if (response?.stale) scheduleCoordinatorSync();
          throw new Error(response?.error || 'The previous browser session could not be cleared.');
        }
        applyCoordinatorMetadata(response);
        state.participantSessionId = '';
      });
    });
    persistChain = clear;
    await clear;
  }

  function applicationsFromStateResponse(response) {
    const saved = response.session;
    const queue = response.queue;
    return (queue?.applications?.length
      ? workQueueEngine.restoreApplications(queue, saved?.apps || [])
      : Array.isArray(saved?.apps) ? saved.apps : [])
      .map((application) => attachApplicationPolicy({
        ...application,
        controlGeneration: Number(response.applicationGenerations?.[application.id] || 0),
        controlRevision: Number(response.applicationRevisions?.[application.id] || 0),
      }));
  }

  async function restore({ preserveView = false } = {}) {
    if (previewMode) return;
    const previousView = state.view;
    const response = await requestAssistantState();
    const saved = response.session;
    const queue = response.queue;
    state.participant = saved?.participant || null;
    state.apps = applicationsFromStateResponse(response);
    applyCoordinatorMetadata(response);
    state.audit = Array.isArray(queue?.audit) ? queue.audit : [];
    state.currentAppId = state.apps.some((application) => application.id === saved?.currentAppId) ? saved.currentAppId : null;
    if (preserveView) state.view = previousView;
    else if (state.apps.length) state.view = 'dashboard';
    else if (state.participant) state.view = 'programs';
    else state.view = 'choice';
  }

  async function synchronizeCoordinator() {
    if (previewMode || coordinatorMutationDepth > 0) {
      coordinatorSyncPending = true;
      return;
    }
    const previousEpoch = state.sessionEpoch;
    const previousParticipantSessionId = state.participantSessionId;
    const previousView = state.view;
    const response = await requestAssistantState();
    const authoritativeAudit = Array.isArray(response.queue?.audit) ? response.queue.audit : [];
    const identityChanged = previousEpoch !== Number(response.sessionEpoch)
      || previousParticipantSessionId !== String(response.participantSessionId || '');
    const authoritativeApps = applicationsFromStateResponse(response);
    if (identityChanged) {
      cancelAllRuns();
      state.apps = authoritativeApps;
      state.audit = authoritativeAudit;
    } else {
      const localById = new Map(state.apps.map((application) => [application.id, application]));
      const authoritativeIds = new Set(authoritativeApps.map((application) => application.id));
      const locallyUnpersistedIds = new Set(state.apps.filter((application) => (
        !authoritativeIds.has(application.id)
        && !Object.hasOwn(response.applicationGenerations || {}, application.id)
        && !Object.hasOwn(response.applicationRevisions || {}, application.id)
      )).map((application) => application.id));
      const changedIds = new Set(state.apps.filter((application) => (
        (!authoritativeIds.has(application.id) && !locallyUnpersistedIds.has(application.id))
        || Number(response.applicationGenerations?.[application.id] || 0) !== Number(application.controlGeneration || 0)
        || Number(response.applicationRevisions?.[application.id] || 0) !== Number(application.controlRevision || 0)
      )).map((application) => application.id));
      changedIds.forEach((id) => {
        const application = localById.get(id);
        if (application) cancelApplicationRun(application);
      });
      state.apps = authoritativeApps.map((authoritative) => {
        const local = localById.get(authoritative.id);
        return local && !changedIds.has(authoritative.id)
          ? local
          : authoritative;
      }).concat([...locallyUnpersistedIds].map((id) => localById.get(id)).filter(Boolean));
      const preservedIds = new Set(state.apps
        .filter((application) => localById.get(application.id) === application)
        .map((application) => application.id));
      const mergedAudit = new Map(authoritativeAudit.map((event) => [event.id, event]));
      state.audit
        .filter((event) => !event.applicationId || preservedIds.has(event.applicationId))
        .forEach((event) => mergedAudit.set(event.id, event));
      state.audit = workQueueEngine.buildQueue([], [...mergedAudit.values()]
        .sort((left, right) => Date.parse(left.at || 0) - Date.parse(right.at || 0))).audit;
      if (state.currentAppId && changedIds.has(state.currentAppId)
        && !['choice', 'programs', 'dashboard'].includes(previousView)) {
        state.view = 'dashboard';
      }
    }
    state.participant = response.session?.participant || null;
    if (!state.apps.some((application) => application.id === state.currentAppId)) {
      state.currentAppId = state.apps.some((application) => application.id === response.session?.currentAppId)
        ? response.session.currentAppId
        : null;
    }
    applyCoordinatorMetadata(response);
    if (identityChanged) state.view = canonicalHomeView();
    else if (!state.apps.length && state.view === 'dashboard') state.view = canonicalHomeView();
    render();
  }

  function coordinatorDelta(coordinator) {
    if (!coordinator || !state.sessionEpoch) return { full: false, applicationIds: [] };
    if (Number(coordinator.sessionEpoch) !== Number(state.sessionEpoch)
      || String(coordinator.participantSessionId || '') !== state.participantSessionId) {
      return { full: true, applicationIds: [] };
    }
    const localIds = new Set(state.apps.map((application) => application.id));
    const coordinatedIds = new Set([
      ...Object.keys(coordinator.applicationGenerations || {}),
      ...Object.keys(coordinator.applicationRevisions || {}),
    ]);
    if ([...coordinatedIds].some((id) => !localIds.has(id))) return { full: true, applicationIds: [] };
    const applicationIds = state.apps.filter((application) => (
      Number(coordinator.applicationGenerations?.[application.id] || 0) !== Number(application.controlGeneration || 0)
      || Number(coordinator.applicationRevisions?.[application.id] || 0) !== Number(application.controlRevision || 0)
    )).map((application) => application.id);
    if (applicationIds.length) return { full: false, applicationIds };
    return {
      full: Number(coordinator.stateRevision || 0) !== Number(state.coordinatorRevision || 0),
      applicationIds: [],
    };
  }

  async function synchronizeApplications(applicationIds) {
    const requestedIds = [...new Set(applicationIds)].filter(Boolean);
    if (!requestedIds.length) return;
    if (previewMode || coordinatorMutationDepth > 0) {
      requestedIds.forEach((id) => pendingApplicationSyncIds.add(id));
      return;
    }
    const response = await requestAssistantState();
    const delta = coordinatorDelta(response);
    if (delta.full) {
      coordinatorSyncPending = true;
      return;
    }
    delta.applicationIds.forEach((id) => requestedIds.push(id));
    const ids = [...new Set(requestedIds)];
    const targetedCurrentApplication = ids.includes(state.currentAppId);
    const authoritativeApps = applicationsFromStateResponse(response);
    const authoritativeById = new Map(authoritativeApps.map((application) => [application.id, application]));
    ids.forEach((id) => {
      const currentIndex = state.apps.findIndex((application) => application.id === id);
      if (currentIndex >= 0) cancelApplicationRun(state.apps[currentIndex]);
      const authoritative = authoritativeById.get(id);
      if (currentIndex >= 0 && authoritative) state.apps.splice(currentIndex, 1, authoritative);
      else if (currentIndex >= 0) state.apps.splice(currentIndex, 1);
      else if (authoritative) state.apps.push(authoritative);
    });
    state.participant = response.session?.participant || null;
    state.audit = Array.isArray(response.queue?.audit) ? response.queue.audit : [];
    if (!state.apps.some((application) => application.id === state.currentAppId)) state.currentAppId = null;
    applyCoordinatorMetadata(response);
    if (targetedCurrentApplication && !['choice', 'programs', 'dashboard'].includes(state.view)) state.view = 'dashboard';
    render();
  }

  function observeCoordinator(coordinator) {
    const delta = coordinatorDelta(coordinator);
    if (!delta.full && !delta.applicationIds.length) return;
    if (coordinatorMutationDepth > 0) {
      pendingCoordinatorSnapshot = coordinator;
      return;
    }
    scheduleCoordinatorSync(delta.full ? null : delta.applicationIds);
  }

  function scheduleCoordinatorSync(applicationIds = null) {
    if (applicationIds === null) coordinatorSyncPending = true;
    else (Array.isArray(applicationIds) ? applicationIds : [applicationIds])
      .filter(Boolean)
      .forEach((id) => pendingApplicationSyncIds.add(id));
    if (previewMode || coordinatorMutationDepth > 0 || coordinatorSyncPromise) return;
    coordinatorSyncPromise = Promise.resolve()
      .then(async () => {
        const full = coordinatorSyncPending;
        coordinatorSyncPending = false;
        const ids = [...pendingApplicationSyncIds];
        pendingApplicationSyncIds.clear();
        if (full) await synchronizeCoordinator();
        else await synchronizeApplications(ids);
      })
      .catch((error) => {
        state.error = error.message;
        render();
      })
      .finally(() => {
        coordinatorSyncPromise = null;
        if ((coordinatorSyncPending || pendingApplicationSyncIds.size) && coordinatorMutationDepth === 0) {
          scheduleCoordinatorSync(coordinatorSyncPending ? null : []);
        }
      });
  }

  async function waitForCoordinatorSync() {
    for (let pass = 0; pass < 4; pass += 1) {
      const pending = coordinatorSyncPromise;
      if (!pending) return;
      await pending;
    }
    if (coordinatorSyncPromise) throw coordinatorStaleError('Assistant state kept changing while it was being reconciled.');
  }

  async function restoreConnector() {
    const response = await sendRuntime({ type: 'GET_CONNECTOR_STATUS' });
    if (!response?.ok) throw new Error(response?.error || 'The data-source status could not be loaded.');
    state.connector = response.connector;
  }

  async function reconcileConnectorMutation(response, uiToken, nextView) {
    if (!response?.ok) {
      if (response?.stale) scheduleCoordinatorSync();
      throw new Error(response?.error || 'The data-source change could not be saved.');
    }
    const previewInvalidation = previewMode && Boolean(state.participant?._connector);
    const returnedEpoch = Number(response.sessionEpoch);
    const coordinatorChanged = !previewMode
      && Number.isSafeInteger(returnedEpoch)
      && returnedEpoch > 0
      && returnedEpoch !== Number(state.sessionEpoch);
    if (response.assistantInvalidated || coordinatorChanged) {
      cancelAllRuns();
      await restore({ preserveView: true });
    } else if (previewInvalidation) {
      cancelAllRuns();
      state.participant = null;
      state.currentAppId = null;
      state.apps.forEach((application) => {
        application.error = 'The connected data source or field mapping changed. Reload the client before resuming.';
        setCheckpoint(application, 'source_expired', 'Reload client data after connector change', 'source_expired');
      });
    } else {
      applyCoordinatorMetadata(response);
    }
    state.connector = response.connector;
    state.connectorDraft = null;
    state.connectorSchema = [];
    state.pendingConnectorRecord = null;
    if (uiToken === uiGeneration) state.view = nextView || canonicalHomeView();
  }

  function setBusy(message = 'Checking this form…') {
    appRoot.innerHTML = `
      <div class="loading">
        <div>
          <div class="spinner" aria-hidden="true"></div>
          <strong>${escapeHtml(message)}</strong>
        </div>
      </div>`;
  }

  function setApplicationProgress(application, message) {
    application.runProgress = message;
    application.updatedAt = new Date().toISOString();
    renderDashboardIfVisible();
  }

  function renderError() {
    return state.error
      ? `<div class="notice error" role="alert"><span aria-hidden="true">!</span><span>${escapeHtml(state.error)}</span></div>`
      : '';
  }

  function renderChoice() {
    appRoot.innerHTML = `
      <section>
        <div class="intro">
          <p class="eyebrow">Start a form</p>
          <h1>Let's find your client</h1>
          <p class="lede">Choose how you want to bring the client's information into this browser session.</p>
        </div>
        ${renderError()}
        ${renderConnectorStatus()}
        <div class="stack">
          <button class="choice-button" type="button" data-action="choose-id">
            <span class="choice-icon" aria-hidden="true">ID</span>
            <span class="choice-copy"><strong>I have their client record ID</strong><small>Use the connected organization data source.</small></span>
            <span class="chevron" aria-hidden="true">›</span>
          </button>
          <button class="choice-button" type="button" data-action="choose-json">
            <span class="choice-icon" aria-hidden="true">{ }</span>
            <span class="choice-copy"><strong>I don't have their record ID</strong><small>Paste the client information as JSON.</small></span>
            <span class="chevron" aria-hidden="true">›</span>
          </button>
          <button class="choice-button" type="button" data-action="choose-document">
            <span class="choice-icon" aria-hidden="true">DOC</span>
            <span class="choice-copy"><strong>Upload a client or business document</strong><small>Review labeled details from scans, images, PDF, Word, text, CSV, or JSON.</small></span>
            <span class="chevron" aria-hidden="true">›</span>
          </button>
        </div>
        <div class="notice" style="margin-top:16px"><span aria-hidden="true">i</span><span>${managedConnector() ? 'Record lookup uses the organization’s read-only connector. Credentials remain in the Nava connector service, never in Chrome.' : 'No production database is connected. All bundled records are fictional.'}</span></div>
      </section>`;
  }

  function renderProviderCatalog() {
    appRoot.innerHTML = `
      <section>
        <button class="back-button" type="button" data-action="home"><span aria-hidden="true">←</span> Home</button>
        <div class="intro">
          <p class="eyebrow">Data source</p>
          <h1>Choose your database</h1>
          <p class="lede">Select the system your organization uses. The extension connects only through a Nava-managed, read-only service; provider credentials never enter Chrome.</p>
        </div>
        ${renderError()}
        <div class="provider-grid">
          ${connectorEngine.PROVIDER_CATALOG.map((provider) => {
            const available = provider.readiness === 'demo-tested';
            return `
            <button class="provider-card" type="button" data-action="select-provider" data-provider="${escapeHtml(provider.id)}" aria-describedby="provider-readiness-${escapeHtml(provider.id)}">
              <span class="provider-icon" aria-hidden="true">${escapeHtml(providerInitials(provider.name))}</span>
              <span class="provider-copy"><strong>${escapeHtml(provider.name)}</strong><small>${escapeHtml(provider.category)}</small></span>
              <span id="provider-readiness-${escapeHtml(provider.id)}" class="readiness-chip ${available ? 'demo-tested' : 'adapter-required'}">${available ? 'Fictional demo available' : 'Provisioned Nava adapter required'}</span>
              <span class="chevron" aria-hidden="true">›</span>
            </button>`;
          }).join('')}
        </div>
        <div class="notice warning" style="margin-top:18px"><span aria-hidden="true">!</span><span>Only the fictional Apricot-shaped adapter runs in this repository. The other providers require an authorized Nava connector service before real records can be retrieved.</span></div>
      </section>`;
  }

  function renderRecordId() {
    const provider = connectorProvider();
    appRoot.innerHTML = `
      <section>
        <button class="back-button" type="button" data-action="back-choice"><span aria-hidden="true">←</span> Back</button>
        <div class="intro">
          <p class="eyebrow">Client record</p>
          <h1>Let's find your client</h1>
          <p class="lede">Enter the client record ID. We'll pull the record through ${escapeHtml(connectorTitle())}.</p>
        </div>
        ${renderError()}
        <form id="record-form" class="stack">
          <div class="field">
            <label for="record-id">${managedConnector() ? escapeHtml(provider.recordLabel) : 'Fictional demo record ID'}</label>
            <input id="record-id" name="recordId" type="text" autocomplete="off" placeholder="Enter ID" required>
            <p class="field-hint">${managedConnector() ? `Read-only ${escapeHtml(provider.name)} connector · source ${escapeHtml(connectorSourceId())} · ${Object.keys(state.connector.mappings || {}).length} mapped fields` : 'Prototype demo IDs: 339619, 338618, and 339637.'}</p>
          </div>
          <div class="form-actions">
            <button class="primary-button" type="submit">Continue</button>
            <button class="secondary-button" type="button" data-action="choose-json">Paste client JSON instead</button>
            <button class="link-button" type="button" data-action="configure-connector">Manage data source</button>
          </div>
        </form>
      </section>`;
  }

  function connectorDraft() {
    if (state.connectorDraft) return state.connectorDraft;
    if (managedConnector()) return { ...state.connector, mappings: { ...(state.connector.mappings || {}) } };
    return {
      provider: 'apricot360',
      organizationName: '',
      backendUrl: '',
      connectionId: '',
      sourceId: '',
      maxAgeDays: 30,
      mappings: {},
    };
  }

  function canonicalHomeView() {
    if (state.apps.length) return 'dashboard';
    if (state.participant) return 'programs';
    return 'choice';
  }

  function renderConnectorSetup() {
    const draft = connectorDraft();
    const provider = connectorProvider(draft);
    appRoot.innerHTML = `
      <section>
        <button class="back-button" type="button" data-action="back-providers"><span aria-hidden="true">←</span> Databases</button>
        <div class="intro">
          <p class="eyebrow">Data source</p>
          <h1>Connect a client data source</h1>
          <p class="lede">Choose a provider, connect through a Nava-managed service, and load labeled fields. Provider credentials remain on the service.</p>
        </div>
        ${renderError()}
        <div class="notice"><span aria-hidden="true">⌁</span><span>The extension accepts an opaque connection ID, never a provider secret, access token, password, or API key. Listed providers still require a Nava service adapter and organization authorization.</span></div>
        <form id="connector-form" class="stack connector-form">
          <div class="field">
            <label for="connector-provider">Database provider</label>
            <select id="connector-provider" name="provider" required>
              ${connectorEngine.PROVIDER_CATALOG.map((item) => `<option value="${escapeHtml(item.id)}" ${draft.provider === item.id ? 'selected' : ''}>${escapeHtml(item.name)} — ${item.readiness === 'demo-tested' ? 'fictional demo' : 'provisioned adapter required'}</option>`).join('')}
            </select>
            <p class="field-hint">Apricot has a tested fictional adapter. Every provider requires a separately deployed, authorized Nava connector before real records can be used.</p>
          </div>
          <div class="field">
            <label for="connector-org">Organization name</label>
            <input id="connector-org" name="organizationName" type="text" value="${escapeHtml(draft.organizationName)}" placeholder="Riverside Community Services" required>
          </div>
          <div class="field">
            <label for="connector-url">Nava connector service URL</label>
            <input id="connector-url" name="backendUrl" type="text" inputmode="url" value="${escapeHtml(draft.backendUrl)}" placeholder="https://connectors.example.org" required>
            <p class="field-hint">HTTPS is required, except for localhost development.</p>
          </div>
          <div class="field">
            <label for="connection-id">Connection ID</label>
            <input id="connection-id" name="connectionId" type="text" value="${escapeHtml(draft.connectionId)}" placeholder="riverside-apricot" autocomplete="off" required>
          </div>
          <div class="grid-fields">
            <div class="field">
              <label for="connector-source-id">Form / resource key</label>
              <input id="connector-source-id" name="sourceId" type="text" value="${escapeHtml(connectorSourceId(draft))}" placeholder="${escapeHtml(provider.sourceLabel)}" required>
            </div>
            <div class="field">
              <label for="connector-age">Stale after</label>
              <select id="connector-age" name="maxAgeDays">
                ${[1, 7, 30, 90].map((days) => `<option value="${days}" ${Number(draft.maxAgeDays) === days ? 'selected' : ''}>${days} day${days === 1 ? '' : 's'}</option>`).join('')}
              </select>
            </div>
          </div>
          <div class="form-actions">
            <button class="primary-button" type="submit">Test connection and load fields</button>
            ${previewMode ? '<button class="secondary-button" type="button" data-action="local-connector-settings">Use local demo settings</button>' : ''}
            ${managedConnector() ? '<button class="link-button danger-link" type="button" data-action="reset-connector">Disconnect and use demo data</button>' : ''}
          </div>
        </form>
      </section>`;
  }

  function renderConnectorMapping() {
    const draft = connectorDraft();
    const schema = connectorEngine.normalizeSchemaFields(state.connectorSchema);
    if (!schema.length) {
      state.view = 'connector';
      return renderConnectorSetup();
    }
    const categories = [...new Set(connectorEngine.CANONICAL_FIELDS.map((field) => field.category))];
    appRoot.innerHTML = `
      <section>
        <button class="back-button" type="button" data-action="back-connector"><span aria-hidden="true">←</span> Connection</button>
        <div class="intro">
          <p class="eyebrow">Schema mapping</p>
          <h1>Confirm what each field means</h1>
          <p class="lede">Suggestions use source labels and reference tags. Review every mapping—opaque or numeric source IDs never determine meaning.</p>
        </div>
        ${renderError()}
        <div class="connector-summary">
          <span class="connector-status-icon" aria-hidden="true">✓</span>
          <span><strong>${escapeHtml(draft.organizationName)}</strong><small>${escapeHtml(connectorProvider(draft).name)} · ${schema.length} labeled source fields loaded · source ${escapeHtml(connectorSourceId(draft))}</small></span>
        </div>
        <form id="connector-mapping-form">
          ${categories.map((category) => `
            <p class="section-label">${escapeHtml(category)}</p>
            <div class="mapping-list">
              ${connectorEngine.CANONICAL_FIELDS.filter((field) => field.category === category).map((canonical) => `
                <label class="mapping-row">
                  <span><strong>${escapeHtml(canonical.label)}</strong>${canonical.sensitive ? '<small>Sensitive · masked in review</small>' : '<small>Canonical destination</small>'}</span>
                  <select name="map-${escapeHtml(canonical.key)}" aria-label="Source field for ${escapeHtml(canonical.label)}">
                    <option value="">Not mapped</option>
                    ${schema.map((field) => `<option value="${escapeHtml(field.id)}" ${draft.mappings?.[canonical.key] === field.id ? 'selected' : ''}>${escapeHtml(field.label)} — ${escapeHtml(field.id)}</option>`).join('')}
                  </select>
                </label>`).join('')}
            </div>`).join('')}
          <div class="notice warning" style="margin-top:18px"><span aria-hidden="true">!</span><span>Saving authorizes read-only lookup through this reviewed mapping. It does not grant the extension permission to edit the source system.</span></div>
          <div class="form-actions">
            <button class="primary-button" type="submit">Save read-only connection</button>
          </div>
        </form>
      </section>`;
  }

  function renderConnectorRecordReview() {
    const record = state.pendingConnectorRecord;
    if (!record?._connector) {
      state.view = 'record';
      return renderRecordId();
    }
    const meta = record._connector;
    const fields = connectorEngine.CANONICAL_FIELDS.filter((field) =>
      record[field.key] !== undefined && record[field.key] !== null && record[field.key] !== '');
    const name = [record.firstName, record.middleName, record.lastName].filter(Boolean).join(' ') || `Record ${record.record_id}`;
    const freshnessText = meta.freshness === 'unknown'
      ? 'Source update time unavailable'
      : meta.stale
        ? `Source updated ${formatTimestamp(meta.sourceModifiedAt)} · may be stale`
        : `Source updated ${formatTimestamp(meta.sourceModifiedAt)}`;
    appRoot.innerHTML = `
      <section>
        <button class="back-button" type="button" data-action="back-record-id"><span aria-hidden="true">←</span> Back</button>
        <div class="intro">
          <p class="eyebrow">Review imported record</p>
          <h1>Confirm this client</h1>
          <p class="lede">Review every mapped value before it enters this browser session and becomes available to application forms.</p>
        </div>
        ${renderError()}
        <div class="connector-summary">
          <span class="connector-status-icon" aria-hidden="true">✓</span>
          <span><strong>${escapeHtml(name)}</strong><small>Record ${escapeHtml(record.record_id)} · ${escapeHtml(meta.organizationName)}</small></span>
        </div>
        <div class="record-preview-list">
          ${fields.map((field) => {
            const source = meta.provenance?.[field.key];
            return `
              <div class="record-preview-row">
                <span><strong>${escapeHtml(field.label)}</strong><small>${escapeHtml(source?.sourceLabel || 'Mapped source field')} · ${escapeHtml(source?.sourceFieldId || '')}</small></span>
                <span class="record-preview-value ${field.sensitive ? 'sensitive' : ''}">${escapeHtml(displayValue(field.key, record[field.key]))}</span>
              </div>`;
          }).join('')}
        </div>
        <div class="notice ${meta.stale ? 'warning' : ''}" style="margin-top:18px"><span aria-hidden="true">${meta.stale ? '!' : 'i'}</span><span>${escapeHtml(freshnessText)}. Retrieved ${escapeHtml(formatTimestamp(meta.retrievedAt))}.</span></div>
        <div class="form-actions">
          <button class="primary-button" type="button" data-action="confirm-connector-record">Use this reviewed record</button>
          <button class="secondary-button" type="button" data-action="back-record-id">Use a different record</button>
        </div>
      </section>`;
  }

  function renderJsonImport() {
    appRoot.innerHTML = `
      <section>
        <button class="back-button" type="button" data-action="back-choice"><span aria-hidden="true">←</span> Back</button>
        <div class="intro">
          <p class="eyebrow">Client data</p>
          <h1>Paste the client record</h1>
          <p class="lede">Use labeled JSON fields. The assistant will never guess a missing value.</p>
        </div>
        ${renderError()}
        <form id="json-form" class="stack">
          <div class="field">
            <label for="client-json">Client information</label>
            <textarea id="client-json" name="clientJson" spellcheck="false" placeholder='{"firstName":"Maria","lastName":"Santos"}' required></textarea>
          </div>
          <button class="link-button" type="button" data-action="use-sample">Use a fictional sample record</button>
          <div class="form-actions">
            <button class="primary-button" type="submit">Continue</button>
          </div>
        </form>
      </section>`;
  }

  function renderDocumentUpload() {
    const backAction = state.participant ? 'back-programs' : 'back-choice';
    appRoot.innerHTML = `
      <section>
        <button class="back-button" type="button" data-action="${backAction}"><span aria-hidden="true">←</span> Back</button>
        <div class="intro">
          <p class="eyebrow">Document intake</p>
          <h1>Upload a client or business document</h1>
          <p class="lede">The assistant reads the file locally and proposes only clearly labeled fields. You choose what to add before anything is used.</p>
        </div>
        ${renderError()}
        <form id="document-form" class="stack">
          <label class="upload-zone" for="client-document">
            <span class="upload-icon" aria-hidden="true">↑</span>
            <strong>Choose a document</strong>
            <span>PDF, PNG, JPEG, WebP, DOCX, TXT, CSV, TSV, or JSON · up to 15 MB</span>
            <input id="client-document" name="clientDocument" type="file" accept=".pdf,.png,.jpg,.jpeg,.webp,.docx,.txt,.csv,.tsv,.json,application/pdf,image/png,image/jpeg,image/webp,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain,text/csv,application/json" required>
          </label>
          <div class="notice"><span aria-hidden="true">⌁</span><span>The raw file stays on this device and is discarded after parsing. Image-only pages use the bundled English OCR model with strict page, pixel, attempt, and time limits.</span></div>
          <div class="form-actions">
            <button class="primary-button" type="submit">Read document</button>
            ${state.participant ? '' : '<button class="secondary-button" type="button" data-action="choose-json">Paste JSON instead</button>'}
          </div>
        </form>
      </section>`;
  }

  function renderDocumentReview() {
    const result = state.documentResult;
    if (!result) {
      state.view = 'document';
      return renderDocumentUpload();
    }
    const current = clientSummary().values;
    const conflictCount = result.fields.filter((field) => {
      const existing = current[field.key];
      return existing !== undefined && existing !== null && existing !== '' && !sameValue(existing, field.value);
    }).length;
    const lowConfidenceCount = result.fields.filter((field) => field.confidence === 'low').length;
    const methodLabel = {
      ocr: 'On-device OCR',
      mixed: 'Embedded text + OCR',
      'embedded-text': 'Embedded PDF text',
      docx: 'Word document text',
      text: 'Plain text',
      'delimited-text': 'Delimited text',
      structured: 'Structured JSON',
    }[result.quality?.method] || 'Local extraction';
    appRoot.innerHTML = `
      <section>
        <button class="back-button" type="button" data-action="back-document"><span aria-hidden="true">←</span> Back</button>
        <div class="intro">
          <p class="eyebrow">Review extracted details</p>
          <h1>Choose what to add</h1>
          <p class="lede">Nothing is merged until you confirm it. Sensitive identifiers are masked here and on later review screens.</p>
        </div>
        ${renderError()}
        <div class="file-summary">
          <span class="file-badge" aria-hidden="true">DOC</span>
          <span><strong>${escapeHtml(result.file.name)}</strong><small>${escapeHtml(methodLabel)} · ${result.fields.length} proposed ${result.fields.length === 1 ? 'field' : 'fields'}${conflictCount ? ` · ${conflictCount} ${conflictCount === 1 ? 'conflict' : 'conflicts'}` : ''}${lowConfidenceCount ? ` · ${lowConfidenceCount} low confidence` : ''}</small></span>
        </div>
        ${result.warnings.map((warning) => `<div class="notice warning document-warning"><span aria-hidden="true">!</span><span>${escapeHtml(warning)}</span></div>`).join('')}
        ${result.fields.length ? `
          <form id="document-review-form">
            <div class="extraction-list">
              ${result.fields.map((field, index) => {
                const existing = current[field.key];
                const hasExisting = existing !== undefined && existing !== null && existing !== '';
                const conflict = hasExisting && !sameValue(existing, field.value);
                return `
                  <label class="extraction-card ${conflict ? 'conflict' : ''} ${field.confidence === 'low' ? 'low-confidence' : ''}">
                    <input type="checkbox" name="fieldIndex" value="${index}" ${conflict || field.confidence === 'low' || field.reviewRequired ? '' : 'checked'}>
                    <span class="extraction-copy">
                      <span class="extraction-heading"><strong>${escapeHtml(field.label)}</strong><span class="confidence-chip ${escapeHtml(field.confidence)}">${escapeHtml(field.confidence)}</span></span>
                      <span class="extracted-value">${escapeHtml(field.displayValue)}</span>
                      <small>${escapeHtml(field.evidence)}</small>
                      ${field.source?.method === 'ocr' ? `<span class="ocr-provenance">Page ${escapeHtml(field.source.pageNumber)}${field.source.region ? ` · region ${escapeHtml(Math.round(field.source.region.x0))},${escapeHtml(Math.round(field.source.region.y0))}–${escapeHtml(Math.round(field.source.region.x1))},${escapeHtml(Math.round(field.source.region.y1))}` : ''}${field.source.canvas?.rotation ? ` · corrected ${escapeHtml(field.source.canvas.rotation)}° rotation` : ''}</span>` : ''}
                      ${field.reviewRequired ? '<span class="conflict-note"><strong>OCR review required:</strong> verify this value in the source before selecting it.</span>' : field.confidence === 'low' ? '<span class="conflict-note"><strong>Low confidence:</strong> verify this value in the source before selecting it.</span>' : ''}
                      ${conflict ? `<span class="conflict-note"><strong>Different from current:</strong> ${escapeHtml(displayValue(field.key, existing))}. Select to replace it.</span>` : ''}
                    </span>
                  </label>`;
              }).join('')}
            </div>
            <div class="form-actions">
              <button class="primary-button" type="submit">Use selected details</button>
              <button class="secondary-button" type="button" data-action="back-document">Choose another file</button>
            </div>
          </form>` : `
          <div class="form-actions">
            <button class="primary-button" type="button" data-action="back-document">Choose another file</button>
            <button class="secondary-button" type="button" data-action="choose-json">Paste JSON instead</button>
          </div>`}
      </section>`;
  }

  function renderPrograms() {
    const client = clientSummary();
    const connectorMeta = state.participant?._connector;
    const tabUrl = state.activeTab?.url || '';
    const currentAllowed = /^https?:/i.test(tabUrl);
    appRoot.innerHTML = `
      <section>
        <button class="back-button" type="button" data-action="${state.apps.length ? 'back-dashboard' : 'change-client'}"><span aria-hidden="true">←</span> ${state.apps.length ? 'Back' : 'Change client'}</button>
        <div class="intro">
          <p class="eyebrow">Applications</p>
          <h1>What should I help with?</h1>
          <p class="lede">Choose this tab or open one of the known application sites. Each application stays in its own tab.</p>
        </div>
        ${renderError()}
        <div class="client-chip">
          <div><strong>${escapeHtml(client.name)}</strong><span>${client.recordId ? `Record ${escapeHtml(client.recordId)}` : state.participant?._documentSources?.length ? 'Document import' : 'Pasted client record'}${connectorMeta ? ` · ${escapeHtml(connectorMeta.organizationName)}` : ''}</span>${connectorMeta ? `<span class="source-freshness ${connectorMeta.stale ? 'stale' : ''}">${connectorMeta.freshness === 'unknown' ? 'Source freshness unavailable' : connectorMeta.stale ? 'Source record may be stale' : `Retrieved ${escapeHtml(formatTimestamp(connectorMeta.retrievedAt))}`}</span>` : ''}</div>
          <div class="client-actions">
            <button class="link-button" type="button" data-action="choose-document">Add document</button>
            <button class="link-button" type="button" data-action="change-client">Change</button>
          </div>
        </div>
        <form id="program-form">
          <p class="section-label">This browser tab</p>
          <div class="program-list">
            <label class="program-option">
              <input type="checkbox" name="program" value="current" ${currentAllowed ? '' : 'disabled'}>
              <span><strong>Analyze this form</strong><small>${escapeHtml(currentAllowed ? hostLabel(tabUrl) : 'Open a website first')}</small></span>
            </label>
          </div>
          <p class="section-label">Known application sites</p>
          <div class="program-list">
            ${programCatalog.PROGRAMS.map((program) => `
              <label class="program-option">
                <input type="checkbox" name="program" value="${escapeHtml(program.id)}">
                <span><strong>${escapeHtml(program.name)}</strong><small>${escapeHtml(program.provider)}${program.workflowId === 'benefitscal' ? ' · combined BenefitsCal application' : ''}</small></span>
              </label>`).join('')}
          </div>
          <div class="notice" style="margin-top:14px"><span aria-hidden="true">i</span><span>CalFresh, Medi-Cal, and CalWORKs share one BenefitsCal application. Selecting more than one opens one tab and carries all selected program names in the same workflow.</span></div>
          <div class="form-actions">
            <button class="primary-button" type="submit">Continue</button>
          </div>
        </form>
      </section>`;
  }

  function progressFor(application) {
    if (application.status === 'ready_for_review') return 100;
    if (application.status === 'needs_attention') return 55;
    if (application.status === 'ready_to_fill') return 35;
    if (['paused', 'handoff_pending'].includes(application.status)) return 20;
    return 8;
  }

  function statusLabel(application) {
    if (activeRunTokens.has(application.id)) return 'Running automatically';
    if (application.status === 'ready_for_review') return 'Ready for review';
    if (application.status === 'needs_attention') return 'Needs your attention';
    if (application.status === 'ready_to_fill') return 'Ready to fill';
    if (application.status === 'no_form') return 'No form found';
    if (application.status === 'paused') return 'Paused safely';
    if (application.status === 'handoff_pending') return 'Handoff waiting';
    if (application.status === 'source_expired') return 'Reload source data';
    if (application.status === 'not_started' && application.autoRun) return 'Starting automatically';
    return 'Not started';
  }

  function applicationCard(application) {
    const running = activeRunTokens.has(application.id);
    const review = application.status === 'ready_for_review';
    const attention = ['needs_attention', 'no_form', 'paused', 'handoff_pending', 'source_expired'].includes(application.status);
    const gaps = application.analysis?.gaps?.length || 0;
    const blocked = application.blocked?.length || 0;
    const completedPages = application.completedPages?.length || 0;
    const note = (running ? application.runProgress : '')
      || application.error
      || application.runStopReason
      || (blocked ? `${blocked} fields need direct help` : '')
      || (gaps ? `${gaps} answers are needed before this page is complete` : '')
      || (review ? (application.runStopReason || 'All writes were read back and verified') : 'Ready to fill the values found in the client record');
    let actions = '';
    if (running) {
      actions = '<span class="automation-badge">Scanning, filling, and continuing in this application tab…</span>';
    } else if (application.status === 'source_expired') {
      actions = '<button class="small-button" type="button" data-action="reload-source">Reload client data</button>';
    } else if (application.status === 'handoff_pending') {
      actions = `<button class="small-button" type="button" data-action="accept-handoff" data-app="${encoded(application.id)}">Accept handoff</button>`;
    } else if (application.programSelectionRequired) {
      actions = '<button class="small-button" type="button" data-action="add-application">Choose programs in a new BenefitsCal application</button>';
    } else if (['captcha', 'otp'].includes(application.checkpoint?.kind) && application.tabId) {
      const challenge = application.checkpoint.kind === 'captcha' ? 'CAPTCHA' : 'one-time code';
      actions = `<button class="small-button" type="button" data-action="resume-human-checkpoint" data-app="${encoded(application.id)}">I completed the ${challenge} — resume</button>`;
    } else if (application.status === 'paused') {
      actions = `<button class="small-button" type="button" data-action="${application.tabId ? 'resume' : 'resume-current'}" data-app="${encoded(application.id)}">${application.tabId ? 'Verify and resume' : 'Reconnect current tab'}</button>`;
    } else if (application.status === 'not_started' && application.autoRun) {
      actions = '<span class="automation-badge">Opening, scanning, and continuing in this tab…</span>';
    } else if (application.status === 'not_started' && application.tabId) {
      actions = `<button class="small-button" type="button" data-action="scan-application" data-app="${encoded(application.id)}">Scan application</button>`;
    } else if (attention && gaps) {
      actions = `<button class="small-button" type="button" data-action="answer-run" data-app="${encoded(application.id)}">Answer and continue</button>
        <button class="small-button secondary" type="button" data-action="answer" data-app="${encoded(application.id)}">This page only</button>`;
    } else if (application.status === 'ready_to_fill') {
      actions = `<button class="small-button" type="button" data-action="run" data-app="${encoded(application.id)}">Fill through application</button>
        <button class="small-button secondary" type="button" data-action="fill" data-app="${encoded(application.id)}">This page only</button>`;
    } else if (review) {
      actions = `<button class="small-button secondary" type="button" data-action="review" data-app="${encoded(application.id)}">Review details</button>`;
    } else if (application.tabId) {
      actions = `<button class="small-button" type="button" data-action="scan-application" data-app="${encoded(application.id)}">Scan this application</button>`;
    } else {
      actions = `<button class="small-button" type="button" data-action="resume-current" data-app="${encoded(application.id)}">Reconnect current tab</button>`;
    }
    if (!['source_expired', 'handoff_pending', 'ready_for_review'].includes(application.status)) {
      actions += `<button class="small-button secondary" type="button" data-action="open-handoff" data-app="${encoded(application.id)}">Pause or hand off</button>`;
    }
    if (application.tabId) actions += `<button class="small-button secondary" type="button" data-action="go-tab" data-app="${encoded(application.id)}">Go to application</button>`;

    return `
      <article class="application-card ${attention ? 'attention' : ''} ${review ? 'review' : ''}">
        <div class="card-row">
          <div class="card-heading">
            <span class="status-icon" aria-hidden="true">${review ? '✓' : attention ? '!' : '•'}</span>
            <div><strong>${escapeHtml(application.name)}</strong><p class="card-note">${escapeHtml(hostLabel(application.url))}</p></div>
          </div>
          <div aria-label="${progressFor(application)} percent complete" class="progress-track"><div class="progress-fill" style="width:${progressFor(application)}%"></div></div>
        </div>
        <p class="card-note"><strong>${escapeHtml(statusLabel(application))}.</strong> ${escapeHtml(note)}</p>
        ${application.owner ? `<p class="ownership-line"><span class="owner-chip ${application.owner.state}">${application.owner.state === 'pending' ? 'Assigned to' : 'Owned by'} ${escapeHtml(application.owner.assignedTo)}</span></p>` : ''}
        ${application.checkpoint ? `<p class="checkpoint-line"><strong>Checkpoint:</strong> ${escapeHtml(application.checkpoint.label)}</p>` : ''}
        ${completedPages ? `<p class="automation-badge">✓ ${completedPages} page${completedPages === 1 ? '' : 's'} completed automatically</p>` : ''}
        <div class="card-actions">${actions}</div>
      </article>`;
  }

  function renderDashboard() {
    const groups = [
      ['NEEDS YOUR ATTENTION', state.apps.filter((item) => ['needs_attention', 'no_form', 'paused', 'handoff_pending', 'source_expired'].includes(item.status))],
      ['IN PROGRESS', state.apps.filter((item) => ['not_started', 'ready_to_fill'].includes(item.status))],
      ['READY FOR REVIEW', state.apps.filter((item) => item.status === 'ready_for_review')],
    ];
    appRoot.innerHTML = `
      <section>
        <div class="intro">
          <p class="eyebrow">Application dashboard</p>
          <h1>${state.participant ? `${escapeHtml(firstName())}'s applications` : 'Resumable work queue'}</h1>
          <p class="lede">${state.participant ? 'The assistant can resume verified pages and continue across approved application steps. It always stops before certification, signature, or submission.' : 'Application progress survived, but client values expired with the browser session. Reload the source record before any application can resume.'}</p>
        </div>
        ${renderError()}
        <div class="queue-summary" aria-label="Work queue summary">
          <span><strong>${state.apps.length}</strong> applications</span>
          <span><strong>${state.apps.filter((item) => ['needs_attention', 'paused', 'handoff_pending', 'source_expired'].includes(item.status)).length}</strong> checkpoints</span>
          <span><strong>${state.apps.filter((item) => item.status === 'ready_for_review').length}</strong> ready</span>
        </div>
        ${groups.map(([label, apps]) => apps.length ? `
          <p class="section-label">${label}</p>
          <div class="stack">${apps.map(applicationCard).join('')}</div>` : '').join('')}
        ${state.apps.length ? '' : '<div class="notice"><span>i</span><span>No application has been added yet.</span></div>'}
        <div class="form-actions">
          <button class="secondary-button" type="button" data-action="${state.participant ? 'add-application' : 'reload-source'}">${state.participant ? 'Add another application' : 'Reload client data'}</button>
          <button class="secondary-button" type="button" data-action="export-audit">Export activity log</button>
          <button class="link-button" type="button" data-action="start-over">End this session</button>
        </div>
      </section>`;
  }

  function renderHandoff() {
    const application = state.apps.find((item) => item.id === state.handoffApplicationId);
    if (!application) {
      state.view = 'dashboard';
      return renderDashboard();
    }
    appRoot.innerHTML = `
      <section>
        <button class="back-button" type="button" data-action="back-dashboard"><span aria-hidden="true">←</span> Back</button>
        <div class="intro">
          <p class="eyebrow">${escapeHtml(application.name)}</p>
          <h1>Pause or hand off</h1>
          <p class="lede">Save an explicit checkpoint so another caseworker or team can understand what needs attention before resuming.</p>
        </div>
        ${renderError()}
        <div class="notice"><span aria-hidden="true">i</span><span>The durable queue stores workflow metadata only. Do not put client names, identifiers, or answers in the assignee field.</span></div>
        <form id="handoff-form">
          <div class="form-stack">
            <label>Caseworker or team
              <input name="assignedTo" type="text" maxlength="80" autocomplete="off" placeholder="Example: Intake team" required>
            </label>
            <label>Reason for handoff
              <select name="reason">
                <option value="client_question">Client question needed</option>
                <option value="direct_entry">Direct form entry needed</option>
                <option value="captcha_or_otp">CAPTCHA or one-time code</option>
                <option value="certification_or_signature">Certification or signature</option>
                <option value="supervisor_review">Supervisor review</option>
                <option value="other">Other checkpoint</option>
              </select>
            </label>
          </div>
          <div class="form-actions">
            <button class="primary-button" type="submit">Create handoff</button>
            <button class="secondary-button" type="button" data-action="pause" data-app="${encoded(application.id)}">Pause for later</button>
          </div>
        </form>
      </section>`;
  }

  function choiceOptions(gap) {
    const options = (gap.options || []).map((option) => ({
      value: option.value ?? option.optionLabel ?? option.label,
      label: option.optionLabel ?? option.label ?? option.value,
    })).filter((option) => option.value !== undefined && option.value !== '');
    if (!options.length && gap.kind === 'decision') {
      return [{ value: 'yes', label: 'Yes' }, { value: 'no', label: 'No' }];
    }
    return options;
  }

  function renderQuestions() {
    const application = state.apps.find((item) => item.id === state.currentAppId);
    if (!application) {
      state.view = 'dashboard';
      return renderDashboard();
    }
    appRoot.innerHTML = `
      <section>
        <button class="back-button" type="button" data-action="back-dashboard"><span aria-hidden="true">←</span> Back</button>
        <div class="intro">
          <p class="eyebrow">${escapeHtml(application.name)}</p>
          <h1>Answer the missing questions</h1>
          <p class="lede">Your answers go directly into the application. Leave a field blank if you do not know it—the assistant will not guess.${application.autoRun ? ' After this page is verified, the assistant will continue through approved next steps.' : ''}</p>
        </div>
        ${application.playbook ? `<div class="notice"><span aria-hidden="true">i</span><span>${escapeHtml(application.playbook.note)}</span></div>` : ''}
        <form id="questions-form">
          <div class="question-list">
            ${(application.analysis?.gaps || []).map((gap, index) => {
              const name = `answer-${index}`;
              const options = choiceOptions(gap);
              return `
                <div class="question-card">
                  <div><p class="question-title">${escapeHtml(gap.question)}</p>${gap.required ? '<p class="field-hint">The form marks this as required.</p>' : ''}</div>
                  ${gap.inputType === 'choice' && options.length ? `
                    <div class="choice-grid">
                      ${options.map((option) => `
                        <label class="choice-pill">
                          <input type="radio" name="${name}" value="${escapeHtml(option.value)}">
                          <span>${escapeHtml(option.label)}</span>
                        </label>`).join('')}
                    </div>` : `
                    <input type="text" name="${name}" autocomplete="off" ${gap.sensitive ? 'inputmode="numeric"' : ''} aria-label="${escapeHtml(gap.question)}">`}
                  <input type="hidden" name="field-${index}" value="${escapeHtml(gap.fieldKey)}">
                </div>`;
            }).join('')}
          </div>
          <div class="form-actions">
            <button class="primary-button" type="submit">${application.autoRun ? 'Fill and continue automatically' : 'Fill this page'}</button>
          </div>
        </form>
      </section>`;
  }

  function sourceLabel(source) {
    return { record: 'Record', changed: 'Changed', user: 'You', page: 'On page', empty: 'Empty' }[source] || source;
  }

  function renderReview() {
    const application = state.apps.find((item) => item.id === state.currentAppId);
    if (!application) {
      state.view = 'dashboard';
      return renderDashboard();
    }
    const completedPages = application.completedPages || [];
    const pageSnapshots = [
      ...completedPages,
      { title: application.page?.title || application.name, provenance: application.provenance || [], empty: application.empty || [], noFields: application.analysis?.noFields || [] },
    ];
    const rows = pageSnapshots.flatMap((page) => [
      ...(page.provenance || []).map((item) => ({ ...item, pageTitle: page.title })),
      ...(page.empty || []).map((item) => ({ label: item.label, value: '(empty)', source: 'empty', detail: item.reason || 'No value was provided', pageTitle: page.title })),
    ]);
    const verified = pageSnapshots.reduce((sum, page) => sum + (page.provenance?.length || 0), 0);
    const empty = pageSnapshots.reduce((sum, page) => sum + (page.empty?.length || 0), 0);
    const noFieldLists = pageSnapshots.map((page) => page.noFields || []);
    const unusedEntries = (noFieldLists[0] || []).filter((candidate) =>
      noFieldLists.every((items) => items.some((item) => item.purpose === candidate.purpose)));
    const unused = unusedEntries.length;
    const gate = application.submitGate || {};
    const stopReason = application.runStopReason || application.navigationGate?.reason || gate.blockedReason
      || 'The assistant will not submit this application. Review the page, complete any affirmation or bot check, and submit it yourself.';
    appRoot.innerHTML = `
      <section>
        <button class="back-button" type="button" data-action="back-dashboard"><span aria-hidden="true">←</span> Back</button>
        <div class="intro">
          <p class="eyebrow">${escapeHtml(application.name)}</p>
          <h1>Review what was filled</h1>
          <p class="lede">Every changed value below was read back from the form. The assistant stopped before the final action so a caseworker can review and submit.</p>
        </div>
        <div class="summary-grid">
          <div class="summary-card"><strong>${verified}</strong><span>Verified</span></div>
          <div class="summary-card"><strong>${empty}</strong><span>Empty</span></div>
          <div class="summary-card"><strong>${pageSnapshots.length}</strong><span>Pages</span></div>
        </div>
        ${completedPages.length ? `<ol class="page-progress-list">${pageSnapshots.map((page, index) => `<li><span>Page ${index + 1}</span><strong>${escapeHtml(page.title || 'Application page')}</strong></li>`).join('')}</ol>` : ''}
        <div class="table-wrap">
          <table class="review-table">
            <thead><tr><th style="width:34%">Field</th><th style="width:36%">Value</th><th style="width:30%">Source</th></tr></thead>
            <tbody>${rows.map((row) => `
              <tr>
                <td><span class="review-page">${escapeHtml(row.pageTitle || '')}</span>${escapeHtml(row.label)}</td>
                <td title="${escapeHtml(row.detail || '')}">${escapeHtml(row.value)}</td>
                <td><span class="source-chip ${escapeHtml(row.source)}">${escapeHtml(sourceLabel(row.source))}</span></td>
              </tr>`).join('')}</tbody>
          </table>
        </div>
        ${unused ? `<p class="card-note" style="margin-top:12px">No matching field in this flow: ${unusedEntries.map((item) => escapeHtml(item.label)).join(', ')}.</p>` : ''}
        <div class="notice warning" style="margin-top:18px"><span aria-hidden="true">!</span><span>${escapeHtml(stopReason)}</span></div>
        <div class="form-actions">
          <button class="primary-button" type="button" data-action="go-tab" data-app="${encoded(application.id)}">Go to application</button>
          <button class="secondary-button" type="button" data-action="rescan" data-app="${encoded(application.id)}">Scan this page again</button>
        </div>
      </section>`;
  }

  function render() {
    const renderView = {
      connector: renderConnectorSetup,
      providers: renderProviderCatalog,
      'connector-mapping': renderConnectorMapping,
      'record-review': renderConnectorRecordReview,
      record: renderRecordId,
      json: renderJsonImport,
      document: renderDocumentUpload,
      'document-review': renderDocumentReview,
      programs: renderPrograms,
      dashboard: renderDashboard,
      handoff: renderHandoff,
      questions: renderQuestions,
      review: renderReview,
    }[state.view] || renderChoice;
    renderView();
    const resetScroll = () => {
      if (document.scrollingElement) document.scrollingElement.scrollTop = 0;
      appRoot.scrollTop = 0;
    };
    resetScroll();
    requestAnimationFrame(() => requestAnimationFrame(resetScroll));
    setTimeout(resetScroll, 100);
  }

  function renderDashboardIfVisible() {
    if (state.view === 'dashboard') render();
  }

  function checkpoint(kind, label) {
    return { kind, label, createdAt: new Date().toISOString() };
  }

  function setCheckpoint(application, kind, label, status = 'paused') {
    application.checkpoint = checkpoint(kind, label);
    application.status = status;
    application.autoRun = false;
    application.runProgress = '';
    application.updatedAt = new Date().toISOString();
    recordAudit('checkpoint_reached', application, { checkpointKind: kind, toStatus: status });
  }

  function checkpointFromScan(response, fieldsFound) {
    if (response.submitGate?.oneTimeCodePresent && !response.submitGate?.oneTimeCodeComplete) return checkpoint('otp', 'One-time code required');
    if (response.analysis?.gaps?.length) return checkpoint('human_input', 'Caseworker answers required');
    if (response.submitGate?.botCheckPresent && !response.submitGate?.botCheckComplete) return checkpoint('captcha', 'Human bot check required');
    if (response.navigationGate?.kind === 'final_review') {
      const signal = `${response.navigationGate.text || ''} ${response.navigationGate.reason || ''}`;
      if (/signature|sign\b/i.test(signal)) return checkpoint('signature', 'Signature required');
      if (/certif|attest|declaration|affirm/i.test(signal)) return checkpoint('certification', 'Certification required');
      return checkpoint('final_review', 'Final review required');
    }
    if (fieldsFound === 0 && response.navigationGate?.kind !== 'next') return checkpoint('navigation_unknown', 'No approved continuation found');
    if (response.navigationGate?.kind === 'manual') return checkpoint('navigation_unknown', 'Manual page continuation required');
    return null;
  }

  function automatedPageLimit(application) {
    if (application.workflowId === 'benefitscal') return MAX_AUTOMATED_PAGES;
    if (application.workflowId === 'riverside-ihss') return 20;
    if (application.workflowId === 'riverside-wic') return 10;
    return DEFAULT_AUTOMATED_PAGES;
  }

  async function acquireApplicationLease(application) {
    const decision = previewMode
      ? workQueueEngine.acquireLease(application, state.workerId, { leaseMs: APPLICATION_LEASE_MS })
      : await sendRuntime({
        type: 'ACQUIRE_APPLICATION_LEASE',
        sessionEpoch: state.sessionEpoch,
        participantSessionId: state.participantSessionId,
        applicationId: application.id,
        applicationGeneration: Number(application.controlGeneration || 0),
        applicationRevision: Number(application.controlRevision || 0),
        holder: state.workerId,
        leaseMs: APPLICATION_LEASE_MS,
      });
    if (!decision?.allowed) {
      if (decision?.stale) {
        scheduleCoordinatorSync(application.id);
        throw coordinatorStaleError(decision?.error);
      }
      throw leaseConflictError(decision?.reason || decision?.error, decision?.lease || null);
    }
    if (!previewMode) {
      applyCoordinatorMetadata(decision);
      application.controlGeneration = Number(decision.applicationGeneration ?? application.controlGeneration ?? 0);
      application.controlRevision = Number(decision.applicationRevision ?? application.controlRevision ?? 0);
    }
    application.lease = decision.lease;
  }

  async function releaseApplicationLease(application) {
    const current = state.apps.find((item) => item.id === application.id) || application;
    if (previewMode) {
      const released = workQueueEngine.releaseLease(current, state.workerId);
      current.lease = released.lease;
    } else {
      const released = await sendRuntime({
        type: 'RELEASE_APPLICATION_LEASE',
        sessionEpoch: state.sessionEpoch,
        participantSessionId: state.participantSessionId,
        applicationId: current.id,
        applicationGeneration: Number(current.controlGeneration || 0),
        applicationRevision: Number(current.controlRevision || 0),
        holder: state.workerId,
      });
      if (!released?.ok) {
        current.lease = null;
        if (released?.stale) {
          scheduleCoordinatorSync(current.id);
          return;
        }
        throw new Error(released?.error || 'The application write lease could not be released.');
      }
      applyCoordinatorMetadata(released);
      current.controlGeneration = Number(released.applicationGeneration ?? current.controlGeneration ?? 0);
      current.controlRevision = Number(released.applicationRevision ?? current.controlRevision ?? 0);
      current.lease = released.lease;
    }
  }

  async function withApplicationLease(application, action) {
    await acquireApplicationLease(application);
    try {
      await persist({ applicationIds: [application.id] });
      return await action();
    } finally {
      await releaseApplicationLease(application);
    }
  }

  async function renewApplicationLease(application, runToken) {
    assertApplicationRun(application, runToken);
    await acquireApplicationLease(application);
    assertApplicationRun(application, runToken);
  }

  async function lookupRecord(recordId, uiToken) {
    assertUiGeneration(uiToken);
    setBusy('Finding the client record…');
    const response = await sendRuntime({ type: 'LOOKUP_RECORD', recordId });
    assertUiGeneration(uiToken);
    if (!response?.ok || !response.record) throw new Error(response?.message || 'No client record was found.');
    if (response.record._connector) {
      state.pendingConnectorRecord = response.record;
      state.view = 'record-review';
      return;
    }
    const activeTab = await getActiveTab();
    assertUiGeneration(uiToken);
    await commitParticipant(response.record);
    assertUiGeneration(uiToken);
    state.activeTab = activeTab;
    state.view = 'programs';
    await persist();
  }

  function urlOrigin(value) {
    try { return new URL(value).origin; } catch { return ''; }
  }

  function urlPath(value) {
    try { return new URL(value).pathname; } catch { return ''; }
  }

  function urlSearch(value) {
    try {
      const url = new URL(value);
      const params = new URLSearchParams(url.search);
      params.sort();
      const normalized = params.toString();
      return normalized ? `?${normalized}` : '';
    } catch {
      return '';
    }
  }

  function urlHash(value) {
    try { return new URL(value).hash; } catch { return ''; }
  }

  function commandLocation(value) {
    try {
      const url = new URL(value);
      return `${url.origin}${url.pathname}${urlSearch(url.href)}${url.hash}`;
    } catch {
      return '';
    }
  }

  function pathMatchesPrefix(path, prefix) {
    if (!path || !prefix) return false;
    if (prefix.endsWith('/')) return path.startsWith(prefix);
    return path === prefix || path.startsWith(`${prefix}/`);
  }

  function participantForApplication(application) {
    if (application?.workflowId !== 'benefitscal') return state.participant;
    if (!Array.isArray(application.programIds) || application.programSelectionRequired) return state.participant;
    const selected = new Set(application.programIds);
    return {
      ...state.participant,
      applicationSelection: {
        calfresh: selected.has('calfresh'),
        medical: selected.has('medical'),
        calworks: selected.has('calworks'),
      },
    };
  }

  function attachApplicationPolicy(application) {
    const currentOrigin = urlOrigin(application.url);
    const matchingProgram = programCatalog.PROGRAMS.find((program) => (
      program.workflowId === application.workflowId
      || program.allowedOrigins?.includes(currentOrigin)
    ));
    return {
      ...application,
      workflowId: application.workflowId || matchingProgram?.workflowId || '',
      allowedOrigins: matchingProgram?.allowedOrigins
        || (application.allowedOrigins?.length ? application.allowedOrigins : (currentOrigin ? [currentOrigin] : [])),
      allowedPathPrefixes: matchingProgram?.allowedPathPrefixes
        || (application.allowedPathPrefixes || []).filter((prefix) => prefix !== '/'),
    };
  }

  function assertApprovedApplicationLocation(application, observedUrl) {
    if (!application?.id) return;
    const observedOrigin = urlOrigin(observedUrl);
    const observedPath = urlPath(observedUrl);
    const approvedOrigins = application.allowedOrigins || [];
    const approvedPathPrefixes = application.allowedPathPrefixes || [];
    const originalOrigin = urlOrigin(application.url);
    const originApproved = approvedOrigins.length
      ? approvedOrigins.includes(observedOrigin)
      : !originalOrigin || originalOrigin === observedOrigin;
    const pathApproved = !approvedPathPrefixes.length
      || approvedPathPrefixes.some((prefix) => pathMatchesPrefix(observedPath, prefix));
    if (!originApproved || !pathApproved) {
      throw new Error(`The ${application.name || 'application'} tab left its approved site. The assistant paused without reading or writing ${hostLabel(observedUrl)}.`);
    }
  }

  async function scanTab(tab, {
    quiet = false,
    applicationId = null,
    runToken = null,
    uiToken = null,
    expectedCommandLocation = '',
    preservePageProgress = false,
  } = {}) {
    if (uiToken !== null) assertUiGeneration(uiToken);
    if (!quiet) setBusy('Checking this form and its required fields…');
    const requestedApplication = applicationId ? state.apps.find((item) => item.id === applicationId) : null;
    const tabApplication = state.apps.find((item) => item.tabId === tab.id);
    let previous = requestedApplication || tabApplication || {};
    if (requestedApplication) {
      assertApprovedApplicationLocation(requestedApplication, tab.url);
      assertApplicationRun(requestedApplication, runToken);
    } else if (tabApplication) {
      try {
        assertApprovedApplicationLocation(tabApplication, tab.url);
        if (urlPath(tabApplication.url) !== urlPath(tab.url)) throw new Error('This tab now shows a different application page.');
      } catch {
        cancelApplicationRun(tabApplication);
        tabApplication.tabId = null;
        tabApplication.runStopReason = 'The tab navigated to a different page. The saved workflow was detached before any client data was read or written.';
        setCheckpoint(tabApplication, 'page_changed', 'Application tab changed', 'paused');
        previous = {};
      }
    }
    const response = await sendToTab(
      tab,
      { type: 'NAVA_SCAN', participant: participantForApplication(previous) },
      { application: requestedApplication || (previous.id ? previous : null), requireLease: Boolean(runToken) },
    );
    if (uiToken !== null) assertUiGeneration(uiToken);
    if (!response?.ok) throw new Error(response?.error || 'The form could not be read.');
    assertApplicationRun(requestedApplication || previous, runToken);
    const observedUrl = response.page?.url || tab.url;
    if (expectedCommandLocation && commandLocation(observedUrl) !== expectedCommandLocation) {
      throw new Error('The application navigated while the assistant was checking for conditional fields. It paused without advancing again.');
    }
    if (requestedApplication) {
      assertApprovedApplicationLocation(requestedApplication, observedUrl);
    }
    const id = previous.id || newWorkflowId();
    const safeAnalysis = {
      ...response.analysis,
      observed: mergeVerifiedProvenance(response.analysis?.observed || []),
    };
    const fieldsFound = safeAnalysis.counts?.fields || 0;
    const canContinue = response.navigationGate?.kind === 'next';
    const nextCheckpoint = checkpointFromScan({ ...response, analysis: safeAnalysis }, fieldsFound);
    const application = {
      ...previous,
      id,
      tabId: tab.id,
      name: previous.requestedName || previous.name || response.playbook?.name || response.page?.title || hostLabel(tab.url),
      queueLabel: previous.requestedName || previous.queueLabel || response.playbook?.name || hostLabel(observedUrl),
      url: observedUrl,
      page: response.page,
      status: fieldsFound === 0 && !canContinue
        ? 'no_form'
        : safeAnalysis.gaps.length
          ? 'needs_attention'
          : 'ready_to_fill',
      analysis: safeAnalysis,
      playbook: response.playbook,
      submitGate: response.submitGate,
      navigationGate: response.navigationGate,
      error: fieldsFound === 0 && !canContinue ? 'No visible application fields or safe continuation controls were found on this page.' : '',
      provenance: provenanceForScan(previous.provenance, safeAnalysis.observed, preservePageProgress),
      blocked: preservePageProgress ? (previous.blocked || []) : [],
      empty: preservePageProgress ? (previous.empty || []) : [],
      checkpoint: nextCheckpoint,
      completedPages: previous.completedPages || [],
      autoRun: Boolean(previous.autoRun),
      visitedSignatures: previous.visitedSignatures || [],
      allowedOrigins: previous.allowedOrigins?.length ? previous.allowedOrigins : [urlOrigin(observedUrl)].filter(Boolean),
      allowedPathPrefixes: previous.allowedPathPrefixes?.length ? previous.allowedPathPrefixes : [urlPath(observedUrl)].filter(Boolean),
      resumePoint: {
        location: response.page?.url || tab.url,
        commandLocationHash: workQueueEngine.signatureHash(commandLocation(response.page?.url || tab.url)),
        pageSignature: response.navigationGate?.pageSignature || '',
        pageSignatureHash: workQueueEngine.signatureHash(response.navigationGate?.pageSignature || ''),
        capturedAt: new Date().toISOString(),
      },
      updatedAt: new Date().toISOString(),
    };
    const existing = state.apps.findIndex((item) => item.id === id);
    if (existing >= 0) state.apps.splice(existing, 1, application);
    else state.apps.unshift(application);
    recordAudit('scan_completed', application, {
      fieldCount: safeAnalysis.counts?.fields || 0,
      gapCount: safeAnalysis.gaps?.length || 0,
      checkpointKind: nextCheckpoint?.kind,
      toStatus: application.status,
    });
    if (safeAnalysis.gaps?.length) {
      recordAudit('questions_required', application, { gapCount: safeAnalysis.gaps.length, checkpointKind: 'human_input' });
    }
    state.currentAppId = id;
    if (!quiet) state.view = 'dashboard';
    assertApplicationRun(application, runToken);
    if (uiToken !== null) assertUiGeneration(uiToken);
    await persist({ applicationIds: [id], includeCurrentAppId: !quiet });
    return application;
  }

  async function openSelectedPrograms(values) {
    const known = values.filter((value) => value !== 'current');
    if (!known.length) return [];
    const response = await sendRuntime({ type: 'OPEN_PROGRAMS', programs: known });
    if (!response?.ok) throw new Error(response?.error || 'The application tabs could not be opened.');
    return response.opened.map((item) => {
      const application = {
        id: newWorkflowId(),
        tabId: item.tabId,
        name: item.name,
        requestedName: item.name,
        queueLabel: item.name,
        url: item.url,
        workflowId: item.workflowId,
        programIds: item.programIds || [],
        allowedOrigins: item.allowedOrigins || [],
        allowedPathPrefixes: item.allowedPathPrefixes || [],
        controlGeneration: 0,
        controlRevision: 0,
        status: 'not_started',
        autoRun: true,
        runStopReason: 'Waiting for the application tab to finish loading.',
        updatedAt: new Date().toISOString(),
      };
      state.apps.push(application);
      recordAudit('application_added', application, { toStatus: 'not_started' });
      return application;
    });
  }

  async function waitForApplicationTab(application, runToken) {
    if (previewMode) return { id: application.tabId, url: application.url, status: 'complete' };
    const startedAt = Date.now();
    while (Date.now() - startedAt < TAB_READY_TIMEOUT_MS) {
      assertApplicationRun(application, runToken);
      let tab = null;
      try {
        tab = await chrome.tabs.get(application.tabId);
      } catch {
        tab = null;
      }
      if (tab?.status === 'complete' && /^https?:/i.test(tab.url || '')) {
        assertApprovedApplicationLocation(application, tab.url);
        try {
          const probe = await probeTabDocument(tab.id);
          assertSameDocumentLocation(tab.url, probe.result.url);
          assertApprovedApplicationLocation(application, probe.result.url);
          await ensurePageAgent({ ...tab, url: probe.result.url }, probe.documentId);
          assertApplicationRun(application, runToken);
          return { ...tab, url: probe.result.url };
        } catch {
          // The document may still be replacing itself during a redirect. Retry.
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    assertApplicationRun(application, runToken);
    throw new Error('The application tab did not become ready within one minute.');
  }

  async function runQueuedApplication(applicationId) {
    let application = state.apps.find((item) => item.id === applicationId);
    if (!application) return;
    const existingRun = activeRunTokens.get(applicationId);
    if (existingRun && !existingRun.cancelled) return;
    let runToken = null;
    try {
      runToken = await beginApplicationRun(application);
      application.runStopReason = '';
      application.autoRun = true;
      setApplicationProgress(application, 'Opening and checking this application tab…');
      await withApplicationLease(application, async () => {
        assertApplicationRun(application, runToken);
        const tab = await waitForApplicationTab(application, runToken);
        assertApplicationRun(application, runToken);
        setApplicationProgress(application, 'Scanning this application and matching client data…');
        application = await scanTab(tab, { quiet: true, applicationId, runToken });
        renderDashboardIfVisible();
        const hasKnownAssignments = Boolean(application.analysis?.assignments?.length);
        if (application.status !== 'ready_to_fill'
          && !(application.status === 'needs_attention' && hasKnownAssignments)) return;
        await runThroughApplication(application, [], [], { background: true, runToken });
      });
    } catch (error) {
      if (error?.name === 'RunCancelledError') {
        scheduleCoordinatorRetry(applicationId);
        return;
      }
      if (error?.name === 'LeaseConflictError') {
        scheduleLeaseRetry(applicationId, error.lease);
        return;
      }
      application = state.apps.find((item) => item.id === applicationId) || application;
      application.error = error.message;
      application.runStopReason = error.message;
      setCheckpoint(application, 'navigation_unknown', 'Automatic run paused', 'needs_attention');
      await persist({ applicationIds: [application.id] });
      renderDashboardIfVisible();
    } finally {
      if (runToken) endApplicationRun(application, runToken);
      renderDashboardIfVisible();
    }
  }

  function eligibleAutomaticApplication(application) {
    const hasKnownAssignments = Boolean(application?.analysis?.assignments?.length);
    const fillableAttentionState = application?.status === 'needs_attention' && hasKnownAssignments;
    return Boolean(application?.autoRun
      && application.tabId
      && (['not_started', 'ready_to_fill'].includes(application.status) || fillableAttentionState));
  }

  function scheduleCoordinatorRetry(applicationId) {
    if (coordinatorRetryIds.has(applicationId)) return;
    coordinatorRetryIds.add(applicationId);
    const sessionEpoch = state.sessionEpoch;
    scheduleCoordinatorSync(applicationId);
    void waitForCoordinatorSync()
      .then(() => {
        coordinatorRetryIds.delete(applicationId);
        if (state.sessionEpoch !== sessionEpoch) return;
        const application = state.apps.find((item) => item.id === applicationId);
        if (!eligibleAutomaticApplication(application)) return;
        void enqueueApplicationBatch([applicationId]).catch((error) => {
          state.error = error.message;
          if (state.view === 'dashboard') render();
        });
      })
      .catch((error) => {
        coordinatorRetryIds.delete(applicationId);
        state.error = error.message;
        if (state.view === 'dashboard') render();
      });
  }

  function scheduleLeaseRetry(applicationId, lease) {
    const expiresAt = Date.parse(lease?.expiresAt || '');
    if (!Number.isFinite(expiresAt)) return;
    const existing = leaseRetryTimers.get(applicationId);
    if (existing) clearTimeout(existing);
    const delay = Math.max(250, Math.min(APPLICATION_LEASE_MS + 1000, expiresAt - Date.now() + 250));
    const timer = setTimeout(() => {
      leaseRetryTimers.delete(applicationId);
      const application = state.apps.find((item) => item.id === applicationId);
      if (!eligibleAutomaticApplication(application) || activeRunTokens.has(applicationId)) return;
      void enqueueApplicationBatch([applicationId]).catch((error) => {
        state.error = error.message;
        if (state.view === 'dashboard') render();
      });
    }, delay);
    leaseRetryTimers.set(applicationId, timer);
  }

  function pumpAutomaticRunQueue() {
    while (automaticWorkersActive < MAX_PARALLEL_APPLICATIONS && automaticRunQueue.length) {
      automaticWorkersActive += 1;
      void (async () => {
        try {
          while (automaticRunQueue.length) {
            const applicationId = automaticRunQueue.shift();
            queuedAutomaticApplicationIds.delete(applicationId);
            await runQueuedApplication(applicationId);
          }
        } catch (error) {
          state.error = error.message;
          if (state.view === 'dashboard') render();
        } finally {
          automaticWorkersActive -= 1;
          pumpAutomaticRunQueue();
          renderDashboardIfVisible();
        }
      })();
    }
  }

  function enqueueApplicationBatch(applicationIds) {
    const ids = [...new Set(applicationIds)].filter(Boolean);
    if (!ids.length) return Promise.resolve();
    ids.forEach((applicationId) => {
      if (queuedAutomaticApplicationIds.has(applicationId)) return;
      queuedAutomaticApplicationIds.add(applicationId);
      automaticRunQueue.push(applicationId);
    });
    pumpAutomaticRunQueue();
    return Promise.resolve();
  }

  async function fillCurrentPage(application, userAssignments = [], unresolved = [], { background = false, runToken = null } = {}) {
    assertApplicationRun(application, runToken);
    const tab = previewMode
      ? { id: application.tabId, url: application.url }
      : await chrome.tabs.get(application.tabId);
    assertApprovedApplicationLocation(application, tab.url);
    if (background) {
      setApplicationProgress(application, `Filling and verifying page ${(application.completedPages?.length || 0) + 1}…`);
    } else {
      setBusy('Filling the page and checking every value…');
    }
    const assignments = [...(application.analysis?.assignments || []), ...userAssignments];
    recordAudit('fill_started', application, { fieldCount: assignments.length, fromStatus: application.status });
    const response = await sendToTab(tab, { type: 'NAVA_FILL', assignments }, { application, requireLease: true });
    if (!response?.ok) throw new Error(response?.error || 'The page could not be filled.');
    if (response.cancelled) throw runCancelledError();
    assertApplicationRun(application, runToken);
    if (response.presentationMode) await new Promise((resolve) => setTimeout(resolve, 1200));
    application.provenance = mergeVerifiedProvenance(
      application.provenance || [],
      application.analysis?.observed || [],
      response.provenance || [],
    );
    application.blocked = (response.results || []).filter((item) => item.status !== 'verified');
    application.empty = [
      ...unresolved.map((gap) => ({ label: gap.label, reason: 'No answer was provided.' })),
      ...application.blocked.map((item) => ({ label: item.label, reason: item.reason })),
    ];
    application.submitGate = response.submitGate || application.submitGate;
    application.navigationGate = response.navigationGate || application.navigationGate;
    application.analysis.gaps = unresolved;
    if (application.empty.length) {
      const kind = application.blocked.length ? 'direct_entry' : 'human_input';
      setCheckpoint(application, kind, application.blocked.length ? 'Direct caseworker entry required' : 'Caseworker answers required', 'needs_attention');
    } else {
      application.status = 'ready_to_fill';
      application.checkpoint = null;
    }
    application.updatedAt = new Date().toISOString();
    recordAudit('page_verified', application, {
      verifiedCount: (response.results || []).filter((item) => item.status === 'verified').length,
      blockedCount: application.blocked.length,
      gapCount: unresolved.length,
      pageCount: (application.completedPages?.length || 0) + 1,
      toStatus: application.status,
    });
    state.currentAppId = application.id;
    assertApplicationRun(application, runToken);
    await persist({ applicationIds: [application.id] });
    return response;
  }

  function archiveCurrentPage(application) {
    const signature = application.navigationGate?.pageSignature || `${application.page?.url || application.url}|${application.page?.title || application.name}`;
    if (application.completedPages?.some((page) => page.signature === signature)) return;
    application.completedPages = [
      ...(application.completedPages || []),
      {
        signature,
        title: application.page?.title || application.name,
        url: application.page?.url || application.url,
        provenance: application.provenance || [],
        empty: application.empty || [],
        noFields: application.analysis?.noFields || [],
        completedAt: new Date().toISOString(),
      },
    ];
  }

  async function navigationStatusFor(tab, application) {
    const response = await sendToTab(tab, { type: 'NAVA_NAVIGATION_STATUS' }, { application, requireLease: true });
    if (!response?.ok) throw new Error(response?.error || 'The next-step control could not be checked.');
    return response.navigationGate;
  }

  async function waitForNextPage(application, previousSignature, runToken) {
    const tabId = application.tabId;
    if (previewMode) return { id: tabId, url: `https://benefitscal.com/ApplyForBenefits/step-${state.previewPage}` };
    const startedAt = Date.now();
    const previousLocation = commandLocation(application.page?.url || application.url);
    const benefitsCalOverview = application.workflowId === 'benefitscal'
      && urlPath(application.page?.url || application.url).toLowerCase() === '/applyforbenefits/begin/abovr';
    let candidateSignature = '';
    let candidateSince = 0;
    while (Date.now() - startedAt < NAVIGATION_TIMEOUT_MS) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      assertApplicationRun(application, runToken);
      try {
        const tab = await chrome.tabs.get(tabId);
        if (tab.status !== 'complete') continue;
        if (benefitsCalOverview && commandLocation(tab.url) === previousLocation) {
          if (Date.now() - startedAt >= 8_000) {
            throw new Error('BenefitsCal returned to the same application overview after BEGIN. The assistant stopped after one attempt instead of reloading it again.');
          }
          continue;
        }
        const gate = await navigationStatusFor(tab, application);
        if (!gate?.pageSignature || gate.pageSignature === previousSignature) {
          candidateSignature = '';
          candidateSince = 0;
          continue;
        }
        if (gate.pageSignature !== candidateSignature) {
          candidateSignature = gate.pageSignature;
          candidateSince = Date.now();
          continue;
        }
        if (Date.now() - candidateSince >= 500) return tab;
      } catch {
        candidateSignature = '';
        candidateSince = 0;
        // Full-page navigations briefly disconnect the content agent. Keep polling.
      }
    }
    throw new Error('The site did not reach a stable new page within one minute after the approved continuation control was activated. The assistant stopped so the caseworker can inspect the application.');
  }

  async function rescanCurrentPageAfterFill(application, runToken) {
    if (previewMode) return null;
    assertApplicationRun(application, runToken);
    const expectedLocation = commandLocation(application.page?.url || application.url);
    const tab = await chrome.tabs.get(application.tabId);
    assertApprovedApplicationLocation(application, tab.url);
    assertSameDocumentLocation(application.page?.url || application.url, tab.url);
    const rescanned = await scanTab(tab, {
      quiet: true,
      applicationId: application.id,
      runToken,
      expectedCommandLocation: expectedLocation,
      preservePageProgress: true,
    });
    assertApplicationRun(rescanned, runToken);
    rescanned.autoRun = true;
    return rescanned;
  }

  async function runThroughApplication(application, userAssignments = [], unresolved = [], { background = false, runToken = null } = {}) {
    assertApplicationRun(application, runToken);
    application.autoRun = true;
    application.runStopReason = '';
    await persist({ applicationIds: [application.id] });
    let current = application;
    let suppliedAssignments = userAssignments;
    let suppliedUnresolved = unresolved;
    let samePageFillPasses = 0;

    for (;;) {
      assertApplicationRun(current, runToken);
      await renewApplicationLease(current, runToken);
      const scannedGaps = current.analysis?.gaps || [];
      const hasSuppliedAnswers = suppliedAssignments.length > 0 || suppliedUnresolved.length > 0;
      const unresolvedForFill = hasSuppliedAnswers ? suppliedUnresolved : scannedGaps;
      const assignmentCount = (current.analysis?.assignments?.length || 0) + suppliedAssignments.length;

      if (!assignmentCount && unresolvedForFill.length) {
        setCheckpoint(current, 'human_input', 'Caseworker answers required', 'needs_attention');
        state.currentAppId = current.id;
        if (!background) state.view = 'questions';
        await persist({ applicationIds: [current.id] });
        return;
      }

      if (assignmentCount) {
        await fillCurrentPage(current, suppliedAssignments, unresolvedForFill, { background, runToken });
        suppliedAssignments = [];
        suppliedUnresolved = [];
        samePageFillPasses += 1;

        if (current.empty.length || current.blocked.length) {
          current.runStopReason = 'The automated run paused after filling the known values because at least one field needs a caseworker answer or direct entry.';
          if (!background) state.view = 'dashboard';
          await persist({ applicationIds: [current.id] });
          return;
        }

        const rescanned = await rescanCurrentPageAfterFill(current, runToken);
        if (rescanned) {
          current = rescanned;
          const hasConditionalWork = Boolean(
            current.analysis?.assignments?.length || current.analysis?.gaps?.length,
          );
          if (hasConditionalWork) {
            if (samePageFillPasses >= MAX_SAME_PAGE_FILL_PASSES) {
              current.runStopReason = `The page revealed more fields after ${MAX_SAME_PAGE_FILL_PASSES} verified fill passes. The assistant stopped before advancing.`;
              current.error = current.runStopReason;
              setCheckpoint(current, 'navigation_unknown', 'Conditional fields require review', 'needs_attention');
              state.currentAppId = current.id;
              if (!background) state.view = 'dashboard';
              await persist({ applicationIds: [current.id] });
              return;
            }
            continue;
          }
        }
      } else {
        suppliedAssignments = [];
        suppliedUnresolved = [];
      }

      const tab = previewMode
        ? { id: current.tabId, url: current.url }
        : await chrome.tabs.get(current.tabId);
      assertApprovedApplicationLocation(current, tab.url);
      assertApplicationRun(current, runToken);
      current.navigationGate = await navigationStatusFor(tab, current);
      assertApplicationRun(current, runToken);

      if (current.navigationGate?.kind !== 'next') {
        current.runStopReason = current.navigationGate?.reason || 'No approved continuation control is visible. Review the application before taking the next action.';
        const signal = `${current.navigationGate?.text || ''} ${current.runStopReason}`;
        const kind = current.submitGate?.oneTimeCodePresent && !current.submitGate?.oneTimeCodeComplete ? 'otp'
          : current.submitGate?.botCheckPresent && !current.submitGate?.botCheckComplete ? 'captcha'
            : /signature|sign\b/i.test(signal) ? 'signature'
            : /certif|attest|declaration|affirm/i.test(signal) ? 'certification'
              : current.navigationGate?.kind === 'final_review' ? 'final_review' : 'navigation_unknown';
        const finalCheckpoint = ['signature', 'certification', 'final_review'].includes(kind);
        const nextStatus = finalCheckpoint ? 'ready_for_review' : 'needs_attention';
        setCheckpoint(current, kind, finalCheckpoint ? 'Human final review required' : 'Caseworker action required', nextStatus);
        if (finalCheckpoint) recordAudit('review_reached', current, { checkpointKind: kind, pageCount: (current.completedPages?.length || 0) + 1, toStatus: nextStatus });
        state.currentAppId = current.id;
        if (!background) state.view = finalCheckpoint ? 'review' : 'dashboard';
        assertApplicationRun(current, runToken);
        await persist({ applicationIds: [current.id] });
        return;
      }

      const pageLimit = automatedPageLimit(current);
      if ((current.completedPages?.length || 0) >= pageLimit - 1) {
        current.runStopReason = `The assistant reached this playbook’s ${pageLimit}-page safety limit and stopped.`;
        current.error = current.runStopReason;
        setCheckpoint(current, 'navigation_unknown', 'Automation page limit reached', 'needs_attention');
        if (!background) state.view = 'dashboard';
        await persist({ applicationIds: [current.id] });
        return;
      }

      const signature = current.navigationGate.pageSignature;
      if (current.visitedSignatures?.includes(signature)) {
        current.runStopReason = 'The application returned to a page it already completed. The assistant stopped to avoid a navigation loop.';
        current.error = current.runStopReason;
        setCheckpoint(current, 'page_changed', 'Repeated application page detected', 'needs_attention');
        if (!background) state.view = 'dashboard';
        await persist({ applicationIds: [current.id] });
        return;
      }

      const progressMessage = `Page ${(current.completedPages?.length || 0) + 1} verified. Moving to the next page…`;
      if (background) setApplicationProgress(current, progressMessage);
      else setBusy(progressMessage);
      assertApplicationRun(current, runToken);
      const advanced = await sendToTab(tab, { type: 'NAVA_ADVANCE' }, { application: current, requireLease: true });
      assertApplicationRun(current, runToken);
      if (!advanced?.ok || !advanced.advanced) {
        throw new Error(advanced?.navigationGate?.reason || 'The approved continuation control was no longer available.');
      }
      recordAudit('safe_advance', current, { pageCount: (current.completedPages?.length || 0) + 1 });
      const nextTab = await waitForNextPage(current, signature, runToken);
      assertApplicationRun(current, runToken);
      current.visitedSignatures = [...(current.visitedSignatures || []), signature];
      archiveCurrentPage(current);
      assertApplicationRun(current, runToken);
      await persist({ applicationIds: [current.id] });
      current = await scanTab(nextTab, { quiet: true, applicationId: current.id, runToken });
      current.autoRun = true;
      samePageFillPasses = 0;
    }
  }

  async function fillApplication(application, userAssignments = [], unresolved = [], { runToken = null } = {}) {
    assertApplicationRun(application, runToken);
    application.autoRun = false;
    application.runStopReason = '';
    await fillCurrentPage(application, userAssignments, unresolved, { runToken });
    assertApplicationRun(application, runToken);
    if (application.empty.length) {
      application.status = 'needs_attention';
    } else {
      const signal = `${application.navigationGate?.text || ''} ${application.navigationGate?.reason || ''}`;
      const kind = application.submitGate?.oneTimeCodePresent && !application.submitGate?.oneTimeCodeComplete ? 'otp'
        : application.submitGate?.botCheckPresent && !application.submitGate?.botCheckComplete ? 'captcha'
          : /signature|sign\b/i.test(signal) ? 'signature'
          : /certif|attest|declaration|affirm/i.test(signal) ? 'certification'
            : application.navigationGate?.kind === 'final_review' ? 'final_review' : 'navigation_unknown';
      const finalCheckpoint = ['signature', 'certification', 'final_review'].includes(kind);
      const nextStatus = finalCheckpoint ? 'ready_for_review' : 'needs_attention';
      setCheckpoint(application, kind, finalCheckpoint ? 'Human review required' : 'Caseworker action required', nextStatus);
      if (finalCheckpoint) recordAudit('review_reached', application, { checkpointKind: kind, pageCount: (application.completedPages?.length || 0) + 1, toStatus: nextStatus });
    }
    application.runStopReason = application.navigationGate?.reason || '';
    assertApplicationRun(application, runToken);
    state.view = application.status === 'ready_for_review' ? 'review' : 'dashboard';
    await persist({ applicationIds: [application.id] });
  }

  async function goToApplication(application) {
    if (previewMode) return;
    const tab = await chrome.tabs.get(application.tabId);
    await chrome.tabs.update(application.tabId, { active: true });
    if (tab.windowId) await chrome.windows.update(tab.windowId, { focused: true });
  }

  async function resumeApplication(application, useCurrentTab = false, { runToken = null } = {}) {
    assertApplicationRun(application, runToken);
    setBusy('Verifying the saved application page before resuming…');
    let tab = null;
    try {
      tab = useCurrentTab ? await getActiveTab() : previewMode
        ? { id: application.tabId || 7001, url: application.url }
        : await chrome.tabs.get(application.tabId);
    } catch {
      tab = null;
    }
    assertApplicationRun(application, runToken);

    if (tab?.id) {
      try {
        assertApprovedApplicationLocation(application, tab.url);
        const expectedLocationHash = application.resumePoint?.locationHash;
        if (expectedLocationHash && expectedLocationHash !== workQueueEngine.signatureHash(workQueueEngine.safeLocation(tab.url))) {
          throw new Error('The open tab is not at the saved application location.');
        }
        const expectedCommandLocationHash = application.resumePoint?.commandLocationHash;
        if (expectedCommandLocationHash && expectedCommandLocationHash !== workQueueEngine.signatureHash(commandLocation(tab.url))) {
          throw new Error('The application query or page state changed since it was paused.');
        }
        if (!application.allowedPathPrefixes?.length) {
          application.allowedOrigins = [urlOrigin(tab.url)].filter(Boolean);
          application.allowedPathPrefixes = [urlPath(tab.url)].filter(Boolean);
        }
      } catch (error) {
        assertApplicationRun(application, runToken);
        application.error = error.message;
        setCheckpoint(application, 'page_changed', 'Application tab changed', 'paused');
        recordAudit('resume_rejected', application, { resumeOutcome: 'location_changed', checkpointKind: 'page_changed', toStatus: 'paused' });
        state.view = 'dashboard';
        await persist({ applicationIds: [application.id] });
        return application;
      }
    }
    assertApplicationRun(application, runToken);

    let response = null;
    if (tab?.id && state.participant && !state.participant?._connector?.stale) {
      try {
        response = await sendToTab(
          tab,
          { type: 'NAVA_SCAN', participant: participantForApplication(application) },
          { application },
        );
      } catch {
        response = null;
      }
    }
    assertApplicationRun(application, runToken);
    const decision = workQueueEngine.resumeDecision(application, response?.ok ? {
      url: response.page?.url || tab?.url,
      pageSignature: response.navigationGate?.pageSignature || '',
    } : null, {
      sourceAvailable: Boolean(state.participant),
      sourceStale: Boolean(state.participant?._connector?.stale),
    });

    if (!decision.allowed) {
      application.error = decision.reason;
      setCheckpoint(application, decision.checkpointKind, decision.reason, decision.outcome === 'source_expired' ? 'source_expired' : 'paused');
      recordAudit('resume_rejected', application, { resumeOutcome: decision.outcome, checkpointKind: decision.checkpointKind, toStatus: application.status });
      state.view = 'dashboard';
      await persist({ applicationIds: [application.id] });
      return application;
    }

    application.tabId = tab.id;
    const resumed = await scanTab(tab, { quiet: true, applicationId: application.id, runToken });
    assertApplicationRun(resumed, runToken);
    resumed.error = '';
    recordAudit('resume_verified', resumed, { resumeOutcome: 'verified', toStatus: resumed.status });
    state.currentAppId = resumed.id;
    state.view = 'dashboard';
    await persist({ applicationIds: [resumed.id] });
    return resumed;
  }

  async function resumeHumanCheckpoint(application, { runToken = null } = {}) {
    assertApplicationRun(application, runToken);
    setBusy('Checking the human verification and resuming the application…');
    const tab = previewMode
      ? { id: application.tabId || 7001, url: application.page?.url || application.url }
      : await chrome.tabs.get(application.tabId);
    assertApprovedApplicationLocation(application, tab.url);
    const expectedLocation = commandLocation(application.page?.url || application.url);
    if (expectedLocation !== commandLocation(tab.url)) {
      application.error = 'The application moved to a different page while waiting for human verification.';
      setCheckpoint(application, 'page_changed', 'Application page changed', 'paused');
      await persist({ applicationIds: [application.id] });
      state.view = 'dashboard';
      return application;
    }

    const rescanned = await scanTab(tab, {
      quiet: true,
      applicationId: application.id,
      runToken,
      expectedCommandLocation: expectedLocation,
      preservePageProgress: true,
    });
    assertApplicationRun(rescanned, runToken);
    const pendingKind = rescanned.submitGate?.oneTimeCodePresent && !rescanned.submitGate?.oneTimeCodeComplete
      ? 'otp'
      : rescanned.submitGate?.botCheckPresent && !rescanned.submitGate?.botCheckComplete
        ? 'captcha'
        : '';
    if (pendingKind) {
      const label = pendingKind === 'captcha' ? 'Human CAPTCHA still required' : 'One-time code still required';
      rescanned.error = pendingKind === 'captcha'
        ? 'Complete the CAPTCHA in the application tab, then try resuming again.'
        : 'Enter the one-time code in the application tab, then try resuming again.';
      rescanned.autoRun = false;
      setCheckpoint(rescanned, pendingKind, label, 'needs_attention');
      recordAudit('checkpoint_reached', rescanned, { checkpointKind: pendingKind, toStatus: 'needs_attention' });
      state.currentAppId = rescanned.id;
      state.view = 'dashboard';
      await persist({ applicationIds: [rescanned.id] });
      return rescanned;
    }

    rescanned.error = '';
    rescanned.runStopReason = '';
    rescanned.checkpoint = null;
    rescanned.autoRun = true;
    recordAudit('checkpoint_completed', rescanned, { checkpointKind: application.checkpoint?.kind, toStatus: rescanned.status });
    await persist({ applicationIds: [rescanned.id] });
    await runThroughApplication(rescanned, [], [], { runToken });
    return rescanned;
  }

  async function exportAuditLog(uiToken) {
    recordAudit('audit_exported', null);
    await persist({ applicationIds: [] });
    assertUiGeneration(uiToken);
    const payload = workQueueEngine.exportAudit(durableQueue());
    const blob = new Blob([`${JSON.stringify(payload, null, 2)}\n`], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `nava-form-filling-activity-${new Date().toISOString().slice(0, 10)}.json`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function onClick(button, initialUiGeneration = uiGeneration) {
    const action = button.dataset.action;
    let uiToken = initialUiGeneration;
    state.error = '';
    if (action === 'home') {
      await cancelUiBoundRuns();
      uiToken = cancelPendingUiWork();
      state.connectorDraft = null;
      state.connectorSchema = [];
      state.pendingConnectorRecord = null;
      state.documentResult = null;
      state.handoffApplicationId = null;
      state.view = canonicalHomeView();
    }
    if (action === 'choose-id') state.view = 'record';
    if (action === 'choose-json') state.view = 'json';
    if (action === 'configure-connector') {
      state.connectorDraft = null;
      state.connectorSchema = [];
      state.pendingConnectorRecord = null;
      state.view = managedConnector() ? 'connector' : 'providers';
    }
    if (action === 'back-providers') state.view = 'providers';
    if (action === 'select-provider') {
      const provider = connectorEngine.providerDefinition(button.dataset.provider);
      if (!provider) throw new Error('Choose a supported data source.');
      state.connectorDraft = {
        provider: provider.id,
        organizationName: '',
        backendUrl: '',
        connectionId: '',
        sourceId: '',
        maxAgeDays: 30,
        mappings: {},
      };
      state.connectorSchema = [];
      state.view = 'connector';
    }
    if (action === 'back-connector') state.view = 'connector';
    if (action === 'local-connector-settings') {
      const providerSelect = document.getElementById('connector-provider');
      providerSelect.value = 'apricot360';
      providerSelect.dispatchEvent(new Event('change', { bubbles: true }));
      document.getElementById('connector-org').value = 'Riverside Community Services';
      document.getElementById('connector-url').value = 'http://127.0.0.1:4789';
      document.getElementById('connection-id').value = 'nava-demo';
      document.getElementById('connector-source-id').value = '99';
      return;
    }
    if (action === 'reset-connector') {
      setBusy('Disconnecting the data source…');
      await withCoordinatorMutation(async () => {
        const response = await sendRuntime({ type: 'RESET_CONNECTOR', sessionEpoch: state.sessionEpoch });
        await reconcileConnectorMutation(response, uiToken, 'choice');
      });
    }
    if (action === 'choose-document') {
      state.documentResult = null;
      state.view = 'document';
    }
    if (action === 'back-choice') state.view = 'choice';
    if (action === 'back-record-id') {
      state.pendingConnectorRecord = null;
      state.view = 'record';
    }
    if (action === 'confirm-connector-record') {
      if (!state.pendingConnectorRecord) throw new Error('Retrieve and review a connector record first.');
      const participant = state.pendingConnectorRecord;
      const activeTab = await getActiveTab();
      assertUiGeneration(uiToken);
      await commitParticipant(participant);
      assertUiGeneration(uiToken);
      state.pendingConnectorRecord = null;
      state.activeTab = activeTab;
      state.view = 'programs';
      await persist();
    }
    if (action === 'back-programs') state.view = 'programs';
    if (action === 'back-document') {
      state.documentResult = null;
      state.view = 'document';
    }
    if (action === 'change-client') {
      cancelAllRuns();
      uiToken = cancelPendingUiWork();
      state.participant = null;
      state.documentResult = null;
      state.pendingConnectorRecord = null;
      state.apps = [];
      state.currentAppId = null;
      state.previewPage = 1;
      state.view = 'choice';
      await clearAssistantState();
    }
    if (action === 'back-dashboard') {
      state.handoffApplicationId = null;
      state.view = 'dashboard';
    }
    if (action === 'add-application') {
      const activeTab = await getActiveTab();
      assertUiGeneration(uiToken);
      state.activeTab = activeTab;
      state.view = 'programs';
    }
    if (action === 'reload-source') {
      state.view = 'choice';
    }
    if (action === 'export-audit') {
      await exportAuditLog(uiToken);
      return;
    }
    if (action === 'use-sample') {
      document.getElementById('client-json').value = JSON.stringify(DEMO_RECORDS['339619'], null, 2);
      return;
    }
    if (action === 'start-over') {
      cancelAllRuns();
      uiToken = cancelPendingUiWork();
      recordAudit('session_ended', null);
      state.participant = null;
      state.documentResult = null;
      state.pendingConnectorRecord = null;
      state.apps = [];
      state.currentAppId = null;
      state.previewPage = 1;
      state.view = 'choice';
      await clearAssistantState();
    }
    if (['answer', 'answer-run', 'fill', 'run', 'review', 'rescan', 'go-tab', 'scan-application', 'resume', 'resume-current', 'resume-human-checkpoint', 'open-handoff', 'pause', 'accept-handoff'].includes(action)) {
      const id = decoded(button.dataset.app);
      const application = state.apps.find((item) => item.id === id);
      if (!application) throw new Error('That application is no longer available.');
      state.currentAppId = id;
      if (action === 'answer' || action === 'answer-run') {
        application.autoRun = action === 'answer-run';
        state.view = 'questions';
      }
      if (action === 'fill') {
        await withNewApplicationRun(
          application,
          (runToken) => withApplicationLease(
            application,
            () => fillApplication(application, [], [], { runToken }),
          ),
          { uiBound: true },
        );
      }
      if (action === 'run') {
        state.view = 'dashboard';
        render();
        await withNewApplicationRun(
          application,
          (runToken) => withApplicationLease(
            application,
            () => runThroughApplication(application, [], [], { background: true, runToken }),
          ),
          { uiBound: true },
        );
      }
      if (action === 'review') state.view = 'review';
      if (action === 'rescan') {
        const tab = previewMode ? { id: application.tabId, url: application.url } : await chrome.tabs.get(application.tabId);
        assertUiGeneration(uiToken);
        await scanTab(tab, { applicationId: application.id, uiToken });
      }
      if (action === 'scan-application') {
        const tab = previewMode ? { id: application.tabId, url: application.url } : await chrome.tabs.get(application.tabId);
        assertUiGeneration(uiToken);
        await scanTab(tab, { applicationId: application.id, uiToken });
      }
      if (action === 'resume' || action === 'resume-current') {
        await withNewApplicationRun(
          application,
          (runToken) => withApplicationLease(
            application,
            () => resumeApplication(application, action === 'resume-current', { runToken }),
          ),
          { uiBound: true },
        );
      }
      if (action === 'resume-human-checkpoint') {
        await withNewApplicationRun(
          application,
          (runToken) => withApplicationLease(
            application,
            () => resumeHumanCheckpoint(application, { runToken }),
          ),
          { uiBound: true },
        );
      }
      if (action === 'open-handoff') {
        await revokeApplicationRun(application);
        setCheckpoint(application, 'voluntary_pause', 'Paused while caseworker chooses a handoff', 'paused');
        state.handoffApplicationId = application.id;
        state.view = 'handoff';
        await persist({ applicationIds: [application.id] });
      }
      if (action === 'pause') {
        await revokeApplicationRun(application);
        setCheckpoint(application, 'voluntary_pause', 'Paused by caseworker', 'paused');
        state.handoffApplicationId = null;
        state.view = 'dashboard';
        await persist({ applicationIds: [application.id] });
      }
      if (action === 'accept-handoff') {
        const acceptedAt = new Date().toISOString();
        application.handoff = { ...application.handoff, acceptedAt };
        application.owner = { ...application.owner, state: 'active', assignedAt: application.owner?.assignedAt || acceptedAt };
        application.status = 'paused';
        application.checkpoint = checkpoint('voluntary_pause', 'Handoff accepted; verify page before resuming');
        application.updatedAt = acceptedAt;
        recordAudit('handoff_accepted', application, { actor: application.owner?.assignedTo, toStatus: 'paused' });
        await persist({ applicationIds: [application.id] });
      }
      if (action === 'go-tab') await goToApplication(application);
    }
    if (action === 'analyze-current') {
      const activeTab = await getActiveTab();
      assertUiGeneration(uiToken);
      state.activeTab = activeTab;
      await scanTab(state.activeTab, { uiToken });
    }
    assertUiGeneration(uiToken);
    render();
  }

  async function onSubmit(form, uiToken = uiGeneration) {
    assertUiGeneration(uiToken);
    state.error = '';
    if (form.id === 'handoff-form') {
      const application = state.apps.find((item) => item.id === state.handoffApplicationId);
      if (!application) throw new Error('That application is no longer available.');
      const data = new FormData(form);
      const assignedTo = String(data.get('assignedTo') || '').replace(/\s+/g, ' ').trim().slice(0, 80);
      const reason = String(data.get('reason') || 'other');
      if (assignedTo.length < 2) throw new Error('Enter the caseworker or team receiving this handoff.');
      const createdAt = new Date().toISOString();
      application.owner = { assignedTo, state: 'pending', assignedAt: createdAt };
      application.handoff = { to: assignedTo, reason, createdAt, acceptedAt: null };
      application.status = 'handoff_pending';
      application.checkpoint = checkpoint('handoff', 'Assigned handoff awaiting acceptance');
      application.autoRun = false;
      application.updatedAt = createdAt;
      recordAudit('handoff_created', application, { actor: assignedTo, checkpointKind: 'handoff', toStatus: 'handoff_pending' });
      state.handoffApplicationId = null;
      state.view = 'dashboard';
      await persist({ applicationIds: [application.id] });
      assertUiGeneration(uiToken);
    }
    if (form.id === 'connector-form') {
      const data = new FormData(form);
      const submittedIdentity = {
        provider: String(data.get('provider') || '').trim(),
        backendUrl: String(data.get('backendUrl') || '').trim(),
        connectionId: String(data.get('connectionId') || '').trim(),
        sourceId: String(data.get('sourceId') || '').trim(),
      };
      const sameMappedSource = managedConnector()
        && ['provider', 'backendUrl', 'connectionId', 'sourceId']
          .every((key) => String(state.connector[key] || '').trim() === submittedIdentity[key]);
      const config = {
        ...submittedIdentity,
        organizationName: String(data.get('organizationName') || '').trim(),
        maxAgeDays: Number(data.get('maxAgeDays')),
        mappings: sameMappedSource ? state.connector.mappings : {},
        mappingVersion: sameMappedSource ? Number(state.connector.mappingVersion || 1) + 1 : 1,
      };
      setBusy('Testing the connector and loading labeled fields…');
      const response = await sendRuntime({ type: 'DISCOVER_CONNECTOR', config });
      assertUiGeneration(uiToken);
      if (!response?.ok) throw new Error(response?.error || 'The connector could not be verified.');
      state.connectorDraft = { ...response.config, mappings: response.suggestions || {} };
      state.connectorSchema = response.schema || [];
      state.view = 'connector-mapping';
    }
    if (form.id === 'connector-mapping-form') {
      const data = new FormData(form);
      const mappings = {};
      connectorEngine.CANONICAL_FIELDS.forEach((field) => {
        const source = String(data.get(`map-${field.key}`) || '').trim();
        if (source) mappings[field.key] = source;
      });
      const config = { ...state.connectorDraft, mappings };
      setBusy('Saving the reviewed field mapping…');
      await withCoordinatorMutation(async () => {
        const response = await sendRuntime({
          type: 'SAVE_CONNECTOR',
          sessionEpoch: state.sessionEpoch,
          config,
          schema: state.connectorSchema,
        });
        await reconcileConnectorMutation(response, uiToken);
      });
    }
    if (form.id === 'record-form') {
      await lookupRecord(new FormData(form).get('recordId'), uiToken);
    }
    if (form.id === 'json-form') {
      const raw = new FormData(form).get('clientJson');
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch {
        throw new Error('That is not valid JSON. Check the commas and quotation marks, then try again.');
      }
      if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') throw new Error('Paste one client record as a JSON object.');
      const activeTab = await getActiveTab();
      assertUiGeneration(uiToken);
      await commitParticipant(parsed);
      assertUiGeneration(uiToken);
      state.activeTab = activeTab;
      state.view = 'programs';
      await persist();
    }
    if (form.id === 'document-form') {
      const file = form.elements.clientDocument?.files?.[0];
      setBusy('Reading the document on this device…');
      const documentResult = await globalThis.NavaDocumentParser.parseDocument(file, {
        onProgress(update) {
          if (uiToken !== uiGeneration) return;
          const page = update.pageNumber ? ` page ${update.pageNumber}${update.totalPages ? ` of ${update.totalPages}` : ''}` : '';
          const percent = Number.isFinite(update.progress) && update.progress > 0 ? ` · ${Math.round(update.progress * 100)}%` : '';
          setBusy(`On-device OCR${page}: ${update.status || 'working'}${percent}`);
        },
      });
      assertUiGeneration(uiToken);
      state.documentResult = documentResult;
      state.view = 'document-review';
    }
    if (form.id === 'document-review-form') {
      const result = state.documentResult;
      if (!result) throw new Error('Choose and read a document first.');
      const selectedIndexes = new FormData(form).getAll('fieldIndex').map(Number);
      if (!selectedIndexes.length) throw new Error('Select at least one detail to use.');
      const selected = selectedIndexes.map((index) => result.fields[index]).filter(Boolean);
      const currentValues = state.participant ? clientSummary().values : {};
      const existing = Object.fromEntries(Object.entries(currentValues).filter(([, value]) => value !== undefined && value !== null && value !== ''));
      const additions = Object.fromEntries(selected.map((field) => [field.key, field.value]));
      const activeTab = await getActiveTab();
      assertUiGeneration(uiToken);
      const participant = {
        ...existing,
        ...additions,
        ...(state.participant?._connector ? { _connector: state.participant._connector } : {}),
        _documentSources: [
          ...(state.participant?._documentSources || []),
          {
            name: result.file.name,
            fields: selected.map((field) => field.key),
            quality: result.quality,
            provenance: selected.map((field) => ({
              key: field.key,
              confidence: field.confidence,
              ocrConfidence: field.ocrConfidence,
              source: field.source,
            })),
          },
        ],
      };
      await commitParticipant(participant);
      assertUiGeneration(uiToken);
      state.documentResult = null;
      state.activeTab = activeTab;
      state.view = 'programs';
      await persist();
    }
    if (form.id === 'program-form') {
      const values = new FormData(form).getAll('program');
      if (!values.length) throw new Error('Choose at least one application or the current form.');
      const applicationsToRun = [];
      if (values.includes('current')) {
        const activeTab = await getActiveTab();
        assertUiGeneration(uiToken);
        state.activeTab = activeTab;
        applicationsToRun.push(await scanTab(state.activeTab, { uiToken }));
      }
      applicationsToRun.push(...await openSelectedPrograms(values));
      const showDashboard = uiToken === uiGeneration;
      if (showDashboard) state.view = 'dashboard';
      await persist({
        applicationIds: applicationsToRun.map((application) => application.id),
        includeCurrentAppId: true,
      });
      if (showDashboard) render();
      void enqueueApplicationBatch(applicationsToRun.map((application) => application.id)).catch((error) => {
        state.error = error.message;
        if (state.view === 'dashboard') render();
      });
      return;
    }
    if (form.id === 'questions-form') {
      const application = state.apps.find((item) => item.id === state.currentAppId);
      if (!application) throw new Error('That application is no longer available.');
      const data = new FormData(form);
      const userAssignments = [];
      const unresolved = [];
      (application.analysis?.gaps || []).forEach((gap, index) => {
        const answer = String(data.get(`answer-${index}`) || '').trim();
        if (!answer) {
          unresolved.push(gap);
          return;
        }
        userAssignments.push({
          fieldKey: gap.fieldKey,
          label: gap.label,
          purpose: gap.purpose,
          value: answer,
          source: 'user',
          detail: 'Your answer in this browser session',
          sensitive: gap.sensitive,
        });
      });
      if (application.autoRun) {
        state.view = 'dashboard';
        render();
        await withNewApplicationRun(
          application,
          (runToken) => withApplicationLease(
            application,
            () => runThroughApplication(application, userAssignments, unresolved, { background: true, runToken }),
          ),
          { uiBound: true },
        );
      }
      else {
        await withNewApplicationRun(
          application,
          (runToken) => withApplicationLease(
            application,
            () => fillApplication(application, userAssignments, unresolved, { runToken }),
          ),
          { uiBound: true },
        );
      }
    }
    assertUiGeneration(uiToken);
    render();
  }

  function previewRuntime(message) {
    if (message.type === 'GET_CONNECTOR_STATUS') {
      return Promise.resolve({
        ok: true,
        connector: state.connector || {
          mode: 'demo',
          provider: 'bundled-demo-records',
          organizationName: 'Nava fictional test data',
          status: 'ready',
        },
      });
    }
    if (message.type === 'DISCOVER_CONNECTOR') {
      try {
        const config = connectorEngine.sanitizeConfig(message.config);
        if (config.provider !== 'apricot360') {
          return Promise.resolve({ ok: false, error: 'This simulated preview includes only the fictional Apricot-shaped adapter. Use a provisioned Nava connector service for this provider.' });
        }
        const schema = connectorEngine.normalizeSchemaFields(PREVIEW_CONNECTOR_SCHEMA);
        return Promise.resolve({
          ok: true,
          health: { organizationName: config.organizationName, provider: config.provider },
          config,
          schema,
          suggestions: connectorEngine.suggestMappings(schema, config.mappings),
        });
      } catch (error) {
        return Promise.resolve({ ok: false, error: error.message });
      }
    }
    if (message.type === 'SAVE_CONNECTOR') {
      try {
        const config = connectorEngine.validateMappings(message.config, message.schema);
        state.connector = { ...config, status: 'ready', connectedAt: new Date().toISOString(), schemaFieldCount: message.schema.length };
        return Promise.resolve({ ok: true, connector: state.connector });
      } catch (error) {
        return Promise.resolve({ ok: false, error: error.message });
      }
    }
    if (message.type === 'RESET_CONNECTOR') {
      state.connector = { mode: 'demo', provider: 'bundled-demo-records', organizationName: 'Nava fictional test data', status: 'ready' };
      return Promise.resolve({ ok: true, connector: state.connector });
    }
    if (message.type === 'LOOKUP_RECORD') {
      if (managedConnector()) {
        if (String(message.recordId) !== '339619') return Promise.resolve({ ok: false, record: null, message: 'The preview connector includes record 339619.' });
        try {
          const mapped = connectorEngine.mapRecord(PREVIEW_RAW_RECORD, state.connector, PREVIEW_CONNECTOR_SCHEMA);
          return Promise.resolve({
            ok: mapped.found,
            record: mapped.record,
            provider: state.connector.provider,
            connector: { organizationName: state.connector.organizationName, stale: mapped.stale, mappedFields: Object.keys(mapped.provenance).length },
            message: 'Record loaded from the preview connector.',
          });
        } catch (error) {
          return Promise.resolve({ ok: false, record: null, error: error.message });
        }
      }
      const record = DEMO_RECORDS[String(message.recordId)] || null;
      return Promise.resolve({
        ok: Boolean(record),
        record,
        message: record ? 'Demo record loaded.' : 'Preview mode only includes demo ID 339619.',
      });
    }
    if (message.type === 'OPEN_PROGRAMS') {
      return Promise.resolve({
        ok: true,
        opened: programCatalog.planWorkflows(message.programs).map((workflow, index) => ({
          ...workflow,
          tabId: 8000 + index,
        })),
      });
    }
    return Promise.resolve({ ok: true });
  }

  function previewTabMessage(message) {
    const previewResponse = (payload, delay = 0) => demoMode && delay
      ? new Promise((resolve) => setTimeout(() => resolve(payload), delay))
      : Promise.resolve(payload);
    const pages = {
      1: {
        title: 'About the applicant',
        fields: [
          { fieldKey: 'page1:first', type: 'text', label: 'First Name', required: true, autocomplete: 'given-name', value: '' },
          { fieldKey: 'page1:middle', type: 'text', label: 'Middle Name', autocomplete: 'additional-name', value: '' },
          { fieldKey: 'page1:last', type: 'text', label: 'Last Name', required: true, autocomplete: 'family-name', value: '' },
          { fieldKey: 'page1:dob', type: 'text', label: 'Date of Birth', required: true, id: 'birthDate', maxLength: 10, value: '' },
        ],
        gate: { kind: 'next', text: 'Next', pageSignature: 'preview:page-1', reason: 'A known safe “Next” control is ready.' },
      },
      2: {
        title: 'Home address',
        fields: [
          { fieldKey: 'page2:street', type: 'text', label: 'Street address', required: true, autocomplete: 'address-line1', value: '' },
          { fieldKey: 'page2:unit', type: 'text', label: 'Apartment or unit', autocomplete: 'address-line2', value: '' },
          { fieldKey: 'page2:city', type: 'text', label: 'City', required: true, autocomplete: 'address-level2', value: '' },
          { fieldKey: 'page2:state', type: 'text', label: 'State', required: true, autocomplete: 'address-level1', value: '' },
          { fieldKey: 'page2:zip', type: 'text', label: 'ZIP code', required: true, autocomplete: 'postal-code', maxLength: 5, value: '' },
        ],
        gate: { kind: 'next', text: 'Save and continue', pageSignature: 'preview:page-2', reason: 'A known safe “Save and continue” control is ready.' },
      },
      3: {
        title: 'Contact and final review',
        fields: [
          { fieldKey: 'page3:email', type: 'email', label: 'Email', required: true, autocomplete: 'email', value: '' },
          { fieldKey: 'page3:phone', type: 'tel', label: 'Mobile Phone', required: true, autocomplete: 'tel', maxLength: 10, value: '' },
          { fieldKey: 'page3:language', type: 'text', label: 'Primary language', autocomplete: 'language', value: '' },
        ],
        gate: { kind: 'final_review', text: 'Submit application', pageSignature: 'preview:page-3', reason: 'The application reached its final review step. Submission stays with the caseworker.' },
      },
    };
    const page = pages[state.previewPage] || pages[3];
    if (message.type === 'NAVA_SCAN') {
      return previewResponse({
        ok: true,
        page: { title: page.title, url: `https://benefitscal.com/ApplyForBenefits/step-${state.previewPage}`, domain: 'benefitscal.com' },
        playbook: { status: 'fresh', name: 'California benefits application', note: 'Bundled BenefitsCal playbook; automatic continuation is limited to exact Begin, Next, and Continue controls.' },
        analysis: engine.buildAnalysis(page.fields, message.participant),
        submitGate: { found: false, enabled: false, botCheckPresent: false, blockedReason: '' },
        navigationGate: page.gate,
      }, 240);
    }
    if (message.type === 'NAVA_FILL') {
      const results = message.assignments.map((item) => ({ ...item, status: 'verified', actual: item.value, reason: '' }));
      return previewResponse({
        ok: true,
        results,
        provenance: results.map((item) => ({ ...item, value: item.sensitive ? '••••' : item.actual })),
        submitGate: state.previewPage === 3
          ? { found: true, enabled: true, botCheckPresent: false, blockedReason: 'The assistant never activates Submit application.' }
          : { found: false, enabled: false, botCheckPresent: false, blockedReason: '' },
        navigationGate: page.gate,
      }, 650);
    }
    if (message.type === 'NAVA_NAVIGATION_STATUS') {
      return previewResponse({ ok: true, navigationGate: page.gate }, 180);
    }
    if (message.type === 'NAVA_ADVANCE') {
      if (page.gate.kind !== 'next') return previewResponse({ ok: true, advanced: false, navigationGate: page.gate });
      state.previewPage = Math.min(3, state.previewPage + 1);
      return previewResponse({ ok: true, advanced: true, navigationGate: page.gate }, 900);
    }
    return previewResponse({ ok: true });
  }

  function loadPreviewQueueFixture() {
    if (!previewMode) return false;
    const fixture = new URLSearchParams(location.search).get('queue');
    if (!fixture) return false;
    const capturedAt = new Date().toISOString();
    state.previewPage = 2;
    const paused = {
      id: 'workflow:preview-benefits',
      tabId: 7001,
      name: 'California benefits application',
      queueLabel: 'California benefits application',
      url: 'https://benefitscal.com/ApplyForBenefits/step-2',
      status: fixture === 'expired' ? 'source_expired' : 'paused',
      completedPages: [{ title: 'About the applicant', provenance: [], completedAt: capturedAt }],
      checkpoint: checkpoint(fixture === 'expired' ? 'source_expired' : 'voluntary_pause', fixture === 'expired' ? 'Reload client data' : 'Paused by caseworker'),
      resumePoint: {
        location: 'https://benefitscal.com/ApplyForBenefits/step-2',
        pageSignatureHash: workQueueEngine.signatureHash('preview:page-2'),
        capturedAt,
      },
      updatedAt: capturedAt,
    };
    const handedOff = {
      id: 'workflow:preview-wic',
      tabId: 8001,
      name: 'WIC',
      queueLabel: 'WIC',
      url: 'https://www.ruhealth.org/appointments/apply-4-wic-form',
      status: 'handoff_pending',
      completedPages: [],
      checkpoint: checkpoint('handoff', 'Assigned handoff awaiting acceptance'),
      owner: { assignedTo: 'Intake team', state: 'pending', assignedAt: capturedAt },
      handoff: { to: 'Intake team', reason: 'client_question', createdAt: capturedAt, acceptedAt: null },
      resumePoint: {
        location: 'https://www.ruhealth.org/appointments/apply-4-wic-form',
        pageSignatureHash: '',
        capturedAt,
      },
      updatedAt: capturedAt,
    };
    state.apps = [paused, handedOff];
    state.participant = fixture === 'expired' ? null : DEMO_RECORDS['339619'];
    state.audit = [workQueueEngine.auditEvent('checkpoint_reached', paused, {
      checkpointKind: paused.checkpoint.kind,
      toStatus: paused.status,
    }, { at: capturedAt, id: 'preview-event' })];
    state.view = 'dashboard';
    return true;
  }

  async function loadPreviewDocumentFixture(uiToken = uiGeneration) {
    if (!previewMode) return false;
    const params = new URLSearchParams(location.search);
    const fixtureKey = params.get('fixture');
    const fixtures = {
      pdf: { name: 'sample-client.pdf', type: 'application/pdf' },
      docx: { name: 'sample-business.docx', type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
      csv: { name: 'sample-business.csv', type: 'text/csv' },
      ocr: { name: 'sample-client-scan.png', type: 'image/png' },
      ocrpdf: { name: 'sample-client-scan.pdf', type: 'application/pdf' },
    };
    const fixture = fixtures[fixtureKey];
    if (!fixture) return false;
    const response = await fetch(`../demo/fixtures/${fixture.name}`);
    if (!response.ok) throw new Error('The local preview document could not be loaded.');
    const file = new File([await response.arrayBuffer()], fixture.name, { type: fixture.type });
    const documentResult = await globalThis.NavaDocumentParser.parseDocument(file);
    assertUiGeneration(uiToken);
    state.documentResult = documentResult;
    if (params.get('conflict') === '1') state.participant = DEMO_RECORDS['339619'];
    state.view = 'document-review';
    return true;
  }

  document.addEventListener('click', (event) => {
    const button = event.target.closest('[data-action]');
    if (!button) return;
    const uiToken = uiGeneration;
    onClick(button, uiToken).catch((error) => {
      if (error?.name === 'UiCancelledError' || uiToken !== uiGeneration) return;
      state.error = error.message;
      render();
    });
  });

  appRoot.addEventListener('submit', (event) => {
    event.preventDefault();
    const uiToken = uiGeneration;
    onSubmit(event.target, uiToken).catch((error) => {
      if (error?.name === 'UiCancelledError' || uiToken !== uiGeneration) return;
      state.error = error.message;
      render();
    });
  });

  appRoot.addEventListener('change', (event) => {
    if (event.target.id !== 'connector-provider') return;
    const provider = connectorEngine.providerDefinition(event.target.value);
    if (!provider) return;
    const sourceLabel = document.querySelector('label[for="connector-source-id"]');
    const sourceInput = document.getElementById('connector-source-id');
    if (sourceLabel) sourceLabel.textContent = provider.sourceLabel;
    if (sourceInput) sourceInput.placeholder = provider.sourceLabel;
  });

  async function refreshActiveTab() {
    if (previewMode) return;
    try {
      state.activeTab = await getActiveTab();
      if (state.view === 'programs') render();
    } catch {
      // Tabs can disappear between Chrome's event and the lookup.
    }
  }

  if (!previewMode) {
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== 'local' || !changes[COORDINATOR_STORAGE_KEY]?.newValue) return;
      observeCoordinator(changes[COORDINATOR_STORAGE_KEY].newValue);
    });
    chrome.tabs.onActivated.addListener(() => {
      void refreshActiveTab();
    });
    chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
      if (!tab.active || (!changeInfo.url && changeInfo.status !== 'complete')) return;
      void refreshActiveTab();
    });
  }

  async function bootstrap() {
    const uiToken = uiGeneration;
    setBusy('Opening the assistant…');
    try {
      await restoreConnector();
      await restore();
      state.activeTab = await getActiveTab();
      assertUiGeneration(uiToken);
      loadPreviewQueueFixture();
      await loadPreviewDocumentFixture(uiToken);
      assertUiGeneration(uiToken);
      render();
      if (!previewMode) {
        const interruptedRuns = state.apps
          .filter((application) => application.autoRun && ['not_started', 'ready_to_fill'].includes(application.status) && application.tabId)
          .map((application) => application.id);
        if (interruptedRuns.length) {
          void enqueueApplicationBatch(interruptedRuns).catch((error) => {
            state.error = error.message;
            state.view = 'dashboard';
            render();
          });
        }
      }
    } catch (error) {
      if (error?.name === 'UiCancelledError' || uiToken !== uiGeneration) return;
      state.error = error.message;
      state.view = 'choice';
      render();
    }
  }

  bootstrap();
})();
