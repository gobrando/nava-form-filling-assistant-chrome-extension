// Side-panel composition root: reads the shared engines and the panel state, creates each panel module in dependency order, keeps the shared render, audit and tab helpers, and starts the panel.
(function startSidePanel() {
  'use strict';

  const appRoot = document.getElementById('app');
  const engine = globalThis.NavaFormEngine;
  const agentPlanner = globalThis.NavaAgenticPlanner;
  const connectorEngine = globalThis.NavaConnectorEngine;
  const workQueueEngine = globalThis.NavaWorkQueueEngine;
  const programCatalog = globalThis.NavaProgramCatalog;
  const recertificationEngine = globalThis.NavaRecertificationEngine;
  const demoConnectorData = globalThis.NavaDemoConnectorData;
  const panelFormat = globalThis.NavaPanelFormat;
  const applicationPolicy = globalThis.NavaApplicationPolicy;
  const scanAnalysis = globalThis.NavaScanAnalysis;
  const {
    escapeHtml,
    decoded,
    mergeVerifiedProvenance,
    provenanceForScan,
    hostLabel,
    mergeAgenticMetadata,
  } = panelFormat;
  const {
    urlOrigin,
    urlPath,
    commandLocation,
    assertSameDocumentLocation,
    checkpoint,
    checkpointFromScan,
    automatedPageLimit,
  } = applicationPolicy;
  const { attachApplicationPolicy, assertApprovedApplicationLocation } = applicationPolicy.create({
    programs: programCatalog.PROGRAMS,
    hostLabel,
  });
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
    agentRuntime: { status: previewMode ? 'preview' : 'checking', message: '' },
    plannerBase: '',
    agentProvider: { kind: 'chrome-local' },
    recertifications: [],
    recertificationWorkspace: {},
    currentRecertificationId: '',
    recertificationSource: '',
  };

  const MAX_SAME_PAGE_FILL_PASSES = 3;
  const NAVIGATION_TIMEOUT_MS = 60_000;
  const COORDINATOR_STORAGE_KEY = 'nava:assistant-coordinator';

  // The preview serves only the shared demo connector's primary fictional record, cloned so the panel never mutates the shared copy.
  const DEMO_RECORDS = Object.fromEntries(demoConnectorData.CLIENT_RECORDS
    .filter((record) => record.record_id === String(demoConnectorData.RECORD_ID))
    .map((record) => [record.record_id, structuredClone(record)]));

  const PREVIEW_CONNECTOR_SCHEMA = demoConnectorData.SCHEMA;
  const PREVIEW_RAW_RECORD = {
    data: [{
      id: demoConnectorData.RECORD_ID,
      attributes: demoConnectorData.recordAttributes(new Date().toISOString()),
    }],
  };

  // Deps that most panel modules share.
  const panelBase = {
    state,
    previewMode,
    sendRuntime,
    setBusy,
    render,
  };

  // Run control owns the run tokens and the session and UI generations. The coordinator revoke and the automatic run
  // queue are created after it, so it reaches them through lazy wrappers.
  const runControl = globalThis.NavaRunControl.create({
    state,
    previewMode,
    checkpoint,
    revokeApplicationRun: (application) => revokeApplicationRun(application),
    onCancelAll: () => automaticRuns.clear(),
  });
  const {
    currentUiGeneration,
    isRunning,
    runCancelledError,
    coordinatorStaleError,
    assertUiGeneration,
    assertApplicationRun,
    cancelApplicationRun,
  } = runControl;
  const parseDocument = (file, options) => globalThis.NavaDocumentParser.parseDocument(file, options);

  // Simulated responses for the extension-free preview; it reads the fictional records declared above.
  const {
    previewRuntime,
    previewTabMessage,
    loadPreviewQueueFixture,
    loadPreviewDocumentFixture,
  } = globalThis.NavaPreviewRuntime.create({
    state,
    previewMode,
    demoMode,
    search: location.search,
    engine,
    connectorEngine,
    programCatalog,
    workQueueEngine,
    DEMO_RECORDS,
    PREVIEW_CONNECTOR_SCHEMA,
    PREVIEW_RAW_RECORD,
    managedConnector,
    checkpoint,
    assertUiGeneration,
    parseDocument,
  });

  const { requestAssistantState, probeTabDocument, ensurePageAgent, sendToTab } = globalThis.NavaExtensionMessaging.create({
    previewMode,
    state,
    sendRuntime,
    previewTabMessage,
    onStaleCommand(application) {
      cancelApplicationRun(application);
      scheduleCoordinatorSync(application.id);
    },
    coordinatorStaleError,
    assertApprovedApplicationLocation,
    assertSameDocumentLocation,
    urlOrigin,
    urlPath,
    urlSearch: applicationPolicy.urlSearch,
    urlHash: applicationPolicy.urlHash,
  });

  // The coordinator: the merge rules, the sync that keeps this window in step with it, and the writes that change it.
  const coordinatorSync = globalThis.NavaCoordinatorSync.create({
    ...panelBase,
    ...runControl,
    ...globalThis.NavaCoordinatorMerge.create({ workQueueEngine }),
    workQueueEngine,
    attachApplicationPolicy,
    requestAssistantState,
    canonicalHomeView,
  });
  const { restore, observeCoordinator, scheduleCoordinatorSync } = coordinatorSync;
  const coordinatorWrites = globalThis.NavaCoordinatorWrites.create({
    ...panelBase,
    ...runControl,
    ...coordinatorSync,
    workQueueEngine,
    recordAudit,
  });
  const { revokeApplicationRun, persist, renewApplicationLease } = coordinatorWrites;

  // The planner runtime: the model provider or the shared gateway, start-up progress, and gateway client links.
  const agentRuntime = globalThis.NavaAgentRuntime.create({
    ...panelBase,
    agentPlanner,
    setApplicationProgress,
    assertUiGeneration,
    activeRunCount: runControl.activeRunCount,
    persist,
  });
  const {
    agentProgressMessage,
    prepareAgentRuntime,
    restorePlannerBase,
    restoreAgentProvider,
    checkAgentAvailability,
  } = agentRuntime;

  // The write path: the page scan, then the multi-page runner over it, each with explicit dependencies.
  const { scanTab } = globalThis.NavaPageScan.create({
    state,
    previewMode,
    engine,
    agentPlanner,
    scanAnalysis,
    scanRecord: scanAnalysis.create({
      signatureHash: workQueueEngine.signatureHash,
      hostLabel,
      provenanceForScan,
      urlOrigin,
      urlPath,
      commandLocation,
    }),
    sendToTab,
    assertApprovedApplicationLocation,
    attachApplicationPolicy,
    urlPath,
    commandLocation,
    checkpointFromScan,
    assertApplicationRun,
    cancelApplicationRun,
    assertUiGeneration,
    setCheckpoint,
    recordAudit,
    persist,
    newWorkflowId,
    setBusy,
    setApplicationProgress,
    agentProgressMessage,
    prepareAgentRuntime,
    mergeVerifiedProvenance,
    mergeAgenticMetadata,
  });
  const {
    runThroughApplication,
    fillApplication,
    goToApplication,
    resumeApplication,
    resumeHumanCheckpoint,
  } = globalThis.NavaApplicationRunner.create({
    state,
    previewMode,
    workQueueEngine,
    scanAnalysis,
    MAX_SAME_PAGE_FILL_PASSES,
    NAVIGATION_TIMEOUT_MS,
    sendToTab,
    scanTab,
    getActiveTab,
    assertApprovedApplicationLocation,
    assertSameDocumentLocation,
    urlOrigin,
    urlPath,
    commandLocation,
    automatedPageLimit,
    stopCheckpoint: applicationPolicy.stopCheckpoint,
    pendingHumanCheck: applicationPolicy.pendingHumanCheck,
    assertApplicationRun,
    runCancelledError,
    renewApplicationLease,
    setCheckpoint,
    recordAudit,
    persist,
    setBusy,
    setApplicationProgress,
    mergeVerifiedProvenance,
  });

  // Automatic runs take opened program tabs through the runner; the recertification caseload prepares cases into them.
  const automaticRuns = globalThis.NavaAutomaticRuns.create({
    ...panelBase,
    ...runControl,
    ...coordinatorSync,
    ...coordinatorWrites,
    newWorkflowId,
    recordAudit,
    probeTabDocument,
    ensurePageAgent,
    assertApprovedApplicationLocation,
    assertSameDocumentLocation,
    scanTab,
    runThroughApplication,
    setApplicationProgress,
    setCheckpoint,
    renderDashboardIfVisible,
  });
  const { openSelectedPrograms, enqueueApplicationBatch } = automaticRuns;
  const recertificationCaseload = globalThis.NavaRecertificationCaseload.create({
    ...panelBase,
    ...runControl,
    ...coordinatorWrites,
    recertificationEngine,
    prepareAgentRuntime,
    openSelectedPrograms,
    enqueueApplicationBatch,
  });

  // Screen templates get explicit dependencies; the connector and intake screens reach each other lazily.
  const viewBase = { state, appRoot, format: panelFormat, renderError };
  const connectorViews = globalThis.NavaConnectorViews.create({
    ...viewBase,
    previewMode,
    connectorEngine,
    managedConnector,
    renderRecordId: () => intakeViews.renderRecordId(),
  });
  const intakeViews = globalThis.NavaIntakeViews.create({
    ...viewBase,
    previewMode,
    engine,
    agentPlanner,
    programCatalog,
    clientSummary,
    managedConnector,
    renderConnectorStatus: connectorViews.renderConnectorStatus,
    connectorTitle: connectorViews.connectorTitle,
    connectorProvider: connectorViews.connectorProvider,
    connectorSourceId: connectorViews.connectorSourceId,
  });
  const recertificationViews = globalThis.NavaRecertificationViews.create({
    ...viewBase,
    recertificationEngine,
    recertificationById: recertificationCaseload.recertificationById,
  });
  const applicationViews = globalThis.NavaApplicationViews.create({
    ...viewBase,
    isRunning,
    renderAgentRuntime: intakeViews.renderAgentRuntime,
    firstName,
  });
  const reviewViews = globalThis.NavaReviewViews.create({ ...viewBase, renderDashboard: applicationViews.renderDashboard });
  const { renderProviderCatalog, renderConnectorSetup, renderConnectorMapping, renderConnectorRecordReview } = connectorViews;
  const { renderChoice, renderRecordId, renderJsonImport, renderDocumentUpload, renderDocumentReview, renderPrograms } = intakeViews;
  const { renderRecertifications, renderRecertificationDetail } = recertificationViews;
  const { renderDashboard, renderHandoff } = applicationViews;
  const { renderQuestions, renderReview } = reviewViews;

  function clientSummary() {
    return engine.canonicalizeParticipant(state.participant || {});
  }

  function firstName() {
    return clientSummary().values.firstName || clientSummary().name || 'Client';
  }

  function managedConnector() {
    return state.connector?.mode === 'managed';
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

  function newWorkflowId() {
    return `workflow:${globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;
  }

  function recordAudit(type, application, details = {}) {
    const event = workQueueEngine.auditEvent(type, application, details);
    state.audit = workQueueEngine.appendAudit(state.audit, event);
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

  function canonicalHomeView() {
    if (state.apps.length) return 'dashboard';
    if (state.participant) return 'programs';
    return 'choice';
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
      recertifications: renderRecertifications,
      'recertification-detail': renderRecertificationDetail,
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

  function setCheckpoint(application, kind, label, status = 'paused') {
    application.checkpoint = checkpoint(kind, label);
    application.status = status;
    application.autoRun = false;
    application.runProgress = '';
    application.updatedAt = new Date().toISOString();
    recordAudit('checkpoint_reached', application, { checkpointKind: kind, toStatus: status });
  }

  // Action tables: each domain's handlers, written against one handler contract, then the dispatcher over them.
  const { SKIP_FINAL_RENDER, showScreen } = globalThis.NavaUiDispatch.handlerContract(state);
  const actionBase = {
    ...panelBase,
    ...runControl,
    ...coordinatorWrites,
    SKIP_FINAL_RENDER,
    showScreen,
    getActiveTab,
    decoded,
  };
  const agentActions = globalThis.NavaAgentActions.create({
    ...actionBase,
    ...agentRuntime,
    enqueueApplicationBatch,
  });
  const recertificationActions = globalThis.NavaRecertificationActions.create({
    ...actionBase,
    ...recertificationCaseload,
    recertificationEngine,
  });
  const intakeActions = globalThis.NavaIntakeActions.create({
    ...actionBase,
    DEMO_RECORDS,
    parseDocument,
    clientSummary,
    canonicalHomeView,
    recordAudit,
    prepareAgentRuntime,
    scanTab,
    openSelectedPrograms,
    enqueueApplicationBatch,
  });
  const connectorActions = globalThis.NavaConnectorActions.create({
    ...actionBase,
    ...coordinatorSync,
    connectorEngine,
    managedConnector,
    canonicalHomeView,
    setCheckpoint,
  });
  const applicationActions = globalThis.NavaApplicationActions.create({
    ...actionBase,
    checkpoint,
    recordAudit,
    setCheckpoint,
    scanTab,
    runThroughApplication,
    fillApplication,
    goToApplication,
    resumeApplication,
    resumeHumanCheckpoint,
  });
  const { restoreConnector } = connectorActions;
  const { installListeners } = globalThis.NavaUiDispatch.create({
    state,
    appRoot,
    render,
    assertUiGeneration,
    currentUiGeneration,
    agentActions,
    recertificationActions,
    intakeActions,
    connectorActions,
    applicationActions,
  });

  installListeners();

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
    const uiToken = currentUiGeneration();
    setBusy('Opening the assistant…');
    try {
      await restoreConnector();
      await restore();
      await restorePlannerBase();
      await restoreAgentProvider();
      state.activeTab = await getActiveTab();
      assertUiGeneration(uiToken);
      loadPreviewQueueFixture();
      await loadPreviewDocumentFixture(uiToken);
      assertUiGeneration(uiToken);
      await checkAgentAvailability();
      render();
    } catch (error) {
      if (error?.name === 'UiCancelledError' || uiToken !== currentUiGeneration()) return;
      state.error = error.message;
      state.view = 'choice';
      render();
    }
  }

  bootstrap();
})();
