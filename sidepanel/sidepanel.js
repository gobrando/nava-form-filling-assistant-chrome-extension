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
  const MAX_PARALLEL_APPLICATIONS = 3;
  const TAB_READY_TIMEOUT_MS = 60_000;
  const NAVIGATION_TIMEOUT_MS = 60_000;
  const APPLICATION_LEASE_MS = 2 * 60 * 1000;
  const QUEUE_STORAGE_KEY = 'nava:work-queue';
  const COORDINATOR_STORAGE_KEY = 'nava:assistant-coordinator';
  const AGENT_PROVIDER_STORAGE_KEY = 'nava:agent-provider';
  const RECERTIFICATION_WORKSPACE_KEY = 'nava:recertification-workspace';
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
    parseDocument: (file) => globalThis.NavaDocumentParser.parseDocument(file),
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
    recertificationById,
  });
  const applicationViews = globalThis.NavaApplicationViews.create({
    ...viewBase,
    isRunning: (applicationId) => activeRunTokens.has(applicationId),
    renderAgentRuntime: intakeViews.renderAgentRuntime,
    firstName,
  });
  const reviewViews = globalThis.NavaReviewViews.create({ ...viewBase, renderDashboard: applicationViews.renderDashboard });
  const { renderProviderCatalog, renderConnectorSetup, renderConnectorMapping, renderConnectorRecordReview } = connectorViews;
  const { renderChoice, renderRecordId, renderJsonImport, renderDocumentUpload, renderDocumentReview, renderPrograms } = intakeViews;
  const { renderRecertifications, renderRecertificationDetail } = recertificationViews;
  const { renderDashboard, renderHandoff } = applicationViews;
  const { renderQuestions, renderReview } = reviewViews;

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

  /** True when this window's control generation or revision for an application differs from the coordinator's. */
  function controlDiffersFromCoordinator(application, coordinator) {
    return Number(coordinator.applicationGenerations?.[application.id] || 0) !== Number(application.controlGeneration || 0)
      || Number(coordinator.applicationRevisions?.[application.id] || 0) !== Number(application.controlRevision || 0);
  }

  /**
   * Merges this window's applications with the coordinator's for the same client session. An application changed
   * elsewhere (control moved, or removed by the coordinator) takes the authoritative copy; an unchanged one keeps the
   * local copy; one the coordinator has never seen stays local. Order: authoritative first, then locally unpersisted.
   */
  function mergeApplicationsWithCoordinator(localApps, authoritativeApps, coordinator) {
    const localById = new Map(localApps.map((application) => [application.id, application]));
    const authoritativeIds = new Set(authoritativeApps.map((application) => application.id));
    const locallyUnpersistedIds = new Set(localApps.filter((application) => (
      !authoritativeIds.has(application.id)
      && !Object.hasOwn(coordinator.applicationGenerations || {}, application.id)
      && !Object.hasOwn(coordinator.applicationRevisions || {}, application.id)
    )).map((application) => application.id));
    const changedIds = new Set(localApps.filter((application) => (
      (!authoritativeIds.has(application.id) && !locallyUnpersistedIds.has(application.id))
      || controlDiffersFromCoordinator(application, coordinator)
    )).map((application) => application.id));
    const apps = authoritativeApps.map((authoritative) => {
      const local = localById.get(authoritative.id);
      return local && !changedIds.has(authoritative.id)
        ? local
        : authoritative;
    }).concat([...locallyUnpersistedIds].map((id) => localById.get(id)).filter(Boolean));
    return { apps, changedIds, localById };
  }

  /** The coordinator's audit plus this window's events for the applications it kept (and session-wide events), in time order. */
  function mergeAuditWithCoordinator(localAudit, authoritativeAudit, preservedIds) {
    const mergedAudit = new Map(authoritativeAudit.map((event) => [event.id, event]));
    localAudit
      .filter((event) => !event.applicationId || preservedIds.has(event.applicationId))
      .forEach((event) => mergedAudit.set(event.id, event));
    return workQueueEngine.buildQueue([], [...mergedAudit.values()]
      .sort((left, right) => Date.parse(left.at || 0) - Date.parse(right.at || 0))).audit;
  }

  /** Keeps the current application if it survived a sync; otherwise adopts the coordinator's saved choice when that one exists. */
  function currentApplicationAfterSync(apps, currentAppId, savedCurrentAppId) {
    const exists = (id) => apps.some((application) => application.id === id);
    if (exists(currentAppId)) return currentAppId;
    return exists(savedCurrentAppId) ? savedCurrentAppId : null;
  }

  /**
   * Same client session: cancels applications changed elsewhere, takes the merged applications and audit, and leaves
   * the current application's screen when that application changed.
   */
  function adoptCoordinatorChanges(response, authoritativeApps, authoritativeAudit, previousView) {
    const { apps, changedIds, localById } = mergeApplicationsWithCoordinator(state.apps, authoritativeApps, response);
    changedIds.forEach((id) => {
      const application = localById.get(id);
      if (application) cancelApplicationRun(application);
    });
    state.apps = apps;
    const preservedIds = new Set(state.apps
      .filter((application) => localById.get(application.id) === application)
      .map((application) => application.id));
    state.audit = mergeAuditWithCoordinator(state.audit, authoritativeAudit, preservedIds);
    if (state.currentAppId && changedIds.has(state.currentAppId)
      && !['choice', 'programs', 'dashboard'].includes(previousView)) {
      state.view = 'dashboard';
    }
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
      adoptCoordinatorChanges(response, authoritativeApps, authoritativeAudit, previousView);
    }
    state.participant = response.session?.participant || null;
    state.currentAppId = currentApplicationAfterSync(state.apps, state.currentAppId, response.session?.currentAppId);
    applyCoordinatorMetadata(response);
    if (identityChanged) state.view = canonicalHomeView();
    else if (!state.apps.length && state.view === 'dashboard') state.view = canonicalHomeView();
    render();
  }

  /** True when the coordinator tracks an application this window has not loaded. */
  function coordinatorHasUnknownApplications(coordinator) {
    const localIds = new Set(state.apps.map((application) => application.id));
    return [
      ...Object.keys(coordinator.applicationGenerations || {}),
      ...Object.keys(coordinator.applicationRevisions || {}),
    ].some((id) => !localIds.has(id));
  }

  function coordinatorDelta(coordinator) {
    if (!coordinator || !state.sessionEpoch) return { full: false, applicationIds: [] };
    if (Number(coordinator.sessionEpoch) !== Number(state.sessionEpoch)
      || String(coordinator.participantSessionId || '') !== state.participantSessionId) {
      return { full: true, applicationIds: [] };
    }
    if (coordinatorHasUnknownApplications(coordinator)) return { full: true, applicationIds: [] };
    const applicationIds = state.apps
      .filter((application) => controlDiffersFromCoordinator(application, coordinator))
      .map((application) => application.id);
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

  function agentProgressMessage(update = {}) {
    if (update.phase === 'download') {
      const percent = Number.isFinite(update.progress) && update.progress > 0
        ? ` ${Math.round(update.progress * 100)}%`
        : '';
      return `Downloading Chrome's on-device language model${percent}…`;
    }
    if (update.phase === 'starting') {
      if (state.agentProvider.kind === 'local-cli') {
        return `Connecting three planner roles to ${state.agentProvider.provider === 'codex' ? 'Codex CLI' : 'Claude Code'}…`;
      }
      return 'Starting three on-device form agents…';
    }
    if (update.phase === 'planning') return 'Field-mapping and gap-analysis agents are reviewing this page…';
    if (update.phase === 'reviewing') return 'The independent review agent is checking the proposed plan…';
    return 'Preparing the on-device form agents…';
  }

  async function prepareAgentRuntime({ application = null } = {}) {
    if (previewMode) return { status: 'preview', agents: [] };
    if (!agentPlanner?.prepare) throw new Error('The agentic planner did not load. Reload the extension and try again.');
    if (agentPlanner.gatewayConfig) {
      const gateway = await agentPlanner.gatewayConfig();
      if (gateway) {
        state.agentRuntime = {
          status: 'ready',
          shared: true,
          message: 'Planning runs on the shared Nava API. Jev decides the confident missing fields. Filling still happens in this tab.',
        };
        return { status: 'ready', agents: ['field_mapper', 'gap_analyst', 'form_reviewer'] };
      }
    }
    if (state.agentRuntime.status === 'ready') return { status: 'ready' };
    const providerTitle = agentPlanner.runtimeInfo?.().title || 'Agentic AI';
    state.agentRuntime = { status: 'starting', message: `Starting ${providerTitle}…` };
    try {
      const prepared = await agentPlanner.prepare({
        onProgress(update) {
          const message = agentProgressMessage(update);
          state.agentRuntime = { status: update.phase === 'ready' ? 'ready' : update.phase, message };
          if (application) setApplicationProgress(application, message);
          else setBusy(message);
        },
      });
      state.agentRuntime = { status: 'ready', message: `${providerTitle} is ready for three planner roles.` };
      return prepared;
    } catch (error) {
      state.agentRuntime = { status: 'unavailable', message: error.message };
      throw error;
    }
  }

  async function restoreAgentProvider() {
    if (previewMode || !agentPlanner?.configure) return;
    let stored = null;
    try {
      stored = (await chrome.storage.session.get(AGENT_PROVIDER_STORAGE_KEY))[AGENT_PROVIDER_STORAGE_KEY] || null;
      state.agentProvider = stored || { kind: 'chrome-local' };
      agentPlanner.configure(state.agentProvider);
    } catch {
      state.agentProvider = { kind: 'chrome-local' };
      agentPlanner.configure(state.agentProvider);
      if (stored) await chrome.storage.session.remove(AGENT_PROVIDER_STORAGE_KEY);
    }
  }

  async function saveAgentProvider(form, uiToken) {
    if (activeRunTokens.size) throw new Error('Wait for the active application runs to pause before changing the model runtime.');
    const data = new FormData(form);
    const selected = String(data.get('modelProvider') || 'chrome-local');
    const config = selected === 'chrome-local'
      ? { kind: 'chrome-local' }
      : {
        kind: 'local-cli',
        provider: selected,
        endpoint: String(data.get('modelEndpoint') || '').trim(),
        token: String(data.get('modelToken') || '').trim(),
        model: selected === 'claude' ? 'sonnet' : '',
      };
    agentPlanner.configure(config);
    state.agentProvider = config;
    state.agentRuntime = { status: 'checking', message: '' };
    await chrome.storage.session.set({ [AGENT_PROVIDER_STORAGE_KEY]: config });
    setBusy(`Connecting ${selected === 'chrome-local' ? 'Chrome on-device AI' : `${selected === 'codex' ? 'Codex CLI' : 'Claude Code'} subscription`}…`);
    await prepareAgentRuntime();
    assertUiGeneration(uiToken);
  }

  function renderError() {
    return state.error
      ? `<div class="notice error" role="alert"><span aria-hidden="true">!</span><span>${escapeHtml(state.error)}</span></div>`
      : '';
  }

  function recertificationById(id = state.currentRecertificationId) {
    return state.recertifications.find((item) => item.id === id) || null;
  }

  function recertificationWorkspaceEntry(item) {
    return {
      requirements: Object.fromEntries(item.requirements.map((requirement) => [requirement.key, {
        status: requirement.status,
        note: requirement.note,
        confirmedAt: requirement.confirmedAt,
      }])),
      consent: item.consent,
      outreach: item.outreach,
      updatedAt: new Date().toISOString(),
    };
  }

  async function saveRecertificationWorkspace(item) {
    state.recertificationWorkspace[item.id] = recertificationWorkspaceEntry(item);
    if (!previewMode) {
      await chrome.storage.session.set({ [RECERTIFICATION_WORKSPACE_KEY]: state.recertificationWorkspace });
    }
  }

  async function loadRecertifications(uiToken = uiGeneration) {
    setBusy('Checking the recertification caseload…');
    if (!previewMode) {
      const stored = await chrome.storage.session.get(RECERTIFICATION_WORKSPACE_KEY);
      state.recertificationWorkspace = stored[RECERTIFICATION_WORKSPACE_KEY] || {};
    }
    const response = await sendRuntime({ type: 'LIST_RECERTIFICATIONS' });
    assertUiGeneration(uiToken);
    if (!response?.ok) throw new Error(response?.error || 'The recertification schedule could not be loaded.');
    state.recertifications = recertificationEngine.normalizeCaseload(response.cases)
      .map((item) => recertificationEngine.mergeWorkspace(item, state.recertificationWorkspace[item.id]));
    state.recertificationSource = response.connector?.organizationName || response.source || '';
    state.view = 'recertifications';
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

  function clientLinkPrograms(programIds) {
    const ids = (programIds || []).filter(Boolean);
    const benefitsCal = new Set(['calfresh', 'medical', 'calworks']);
    if (benefitsCal.has(ids[0])) return ids.filter((id) => benefitsCal.has(id));
    return ids.slice(0, 1);
  }

  function apiInputType(gap) {
    const type = String(gap.inputType || '');
    if (type === 'multi_choice') return 'checkbox';
    if (['text', 'select', 'radio', 'checkbox', 'date', 'number'].includes(type)) return type;
    return Array.isArray(gap.options) && gap.options.length ? 'select' : 'text';
  }

  /**
   * Creates an API application for the open questions and returns a link the
   * client can answer. Values stay in this tab. The request sends questions
   * only, and the audit log on the API records that an application was added.
   */
  async function mintClientLink(application) {
    const gateway = await agentPlanner.gatewayConfig();
    if (!gateway) throw new Error('Save the shared planner API address and a tenant key first.');
    const programIds = clientLinkPrograms(application.programIds);
    if (!programIds.length) throw new Error('Choose a program before creating a client link.');
    const questions = (application.analysis?.gaps || []).slice(0, 40).map((gap) => ({
      fieldKey: String(gap.fieldKey || '').slice(0, 180),
      label: String(gap.label || gap.fieldKey || 'Question').slice(0, 200),
      question: String(gap.question || 'What is the answer?').slice(0, 240),
      required: Boolean(gap.required),
      inputType: apiInputType(gap),
      options: (Array.isArray(gap.options) ? gap.options : [])
        .map((option) => String(option.label || option.value || option))
        .filter(Boolean)
        .slice(0, 20),
    })).filter((gap) => gap.fieldKey && gap.question);
    if (!questions.length) throw new Error('This page has no questions to send.');
    const base = gateway.endpoint.replace(/\/v1\/plan$/, '');
    const headers = {
      authorization: `Bearer ${gateway.token}`,
      'content-type': 'application/json',
    };
    async function post(path, body) {
      const response = await fetch(`${base}${path}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || payload.ok === false) {
        throw new Error(payload.error || `The API returned ${response.status}.`);
      }
      return payload;
    }
    const household = await post('/v1/households', { externalRef: `extension-${application.id}` });
    const created = await post('/v1/applications', {
      householdId: household.household.id,
      programIds,
      questions,
    });
    const share = await post(`/v1/applications/${created.application.id}/share`, {
      createdBy: 'extension-caseworker',
    });
    application.clientLink = share.url;
    await persist({ applicationIds: [application.id] });
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

  async function prepareRecertification(item, uiToken) {
    if (!item.readyToPrepare) throw new Error('Complete the data check and record the client’s authorization first.');
    const activeRecordId = String(state.participant?.record_id || state.participant?.recordId || '');
    if (state.apps.length && activeRecordId && activeRecordId !== item.recordId) {
      throw new Error('Finish or end the active client session before loading a different client’s recertification.');
    }
    setBusy(`Loading ${item.displayName}'s authorized source record…`);
    const response = await sendRuntime({ type: 'LOOKUP_RECORD', recordId: item.recordId });
    assertUiGeneration(uiToken);
    if (!response?.ok || !response.record) throw new Error(response?.error || response?.message || 'The client record could not be loaded.');
    if (!activeRecordId || activeRecordId !== item.recordId) await commitParticipant(response.record);
    assertUiGeneration(uiToken);
    await prepareAgentRuntime();
    assertUiGeneration(uiToken);
    const applications = await openSelectedPrograms([item.programId]);
    state.view = 'dashboard';
    await persist({ applicationIds: applications.map((application) => application.id), includeCurrentAppId: true });
    render();
    void enqueueApplicationBatch(applications.map((application) => application.id)).catch((error) => {
      state.error = error.message;
      if (state.view === 'dashboard') render();
    });
  }

  async function onClick(button, initialUiGeneration = uiGeneration) {
    const action = button.dataset.action;
    state.error = '';
    await runUiHandler(CLICK_ACTIONS, action, { action, button, uiToken: initialUiGeneration });
  }

  async function onSubmit(form, uiToken = uiGeneration) {
    assertUiGeneration(uiToken);
    state.error = '';
    await runUiHandler(SUBMIT_ACTIONS, form.id, { form, uiToken });
  }

  // Click and submit handlers share one ending. By default the dispatcher re-checks the UI generation and renders.
  // A handler that starts a new UI generation returns { uiToken } so the check uses it. SKIP_FINAL_RENDER means the
  // handler has already rendered, or it changed inputs on the current screen that a render would wipe out.
  const SKIP_FINAL_RENDER = Object.freeze({ skipFinalRender: true });

  async function runUiHandler(handlers, key, context) {
    const handler = handlers.get(key);
    const outcome = handler ? await handler(context) : undefined;
    if (outcome === SKIP_FINAL_RENDER) return;
    assertUiGeneration(outcome?.uiToken ?? context.uiToken);
    render();
  }

  /** A handler for buttons whose only effect is switching to another screen. */
  function showScreen(view) {
    return () => {
      state.view = view;
    };
  }

  // Agent runtime and shared planner gateway actions.

  async function savePlannerGateway({ uiToken }) {
    const baseInput = document.getElementById('nava-api-base');
    const tokenInput = document.getElementById('nava-api-token');
    const base = String(baseInput?.value || '').trim();
    const token = String(tokenInput?.value || '').trim();
    let origin = '';
    try {
      origin = new URL(base).origin;
    } catch {
      throw new Error('Enter the full API address, including https.');
    }
    if (!token && !state.plannerBase) throw new Error('Paste a tenant API key.');
    const stored = { navaApiBase: origin };
    if (token) stored.navaApiToken = token;
    await chrome.storage.local.set(stored);
    state.plannerBase = origin;
    await prepareAgentRuntime();
    assertUiGeneration(uiToken);
  }

  async function createClientLink({ uiToken }) {
    const application = state.apps.find((item) => item.id === state.currentAppId);
    if (!application) return SKIP_FINAL_RENDER;
    await mintClientLink(application);
    assertUiGeneration(uiToken);
    render();
  }

  async function enableAgent({ uiToken }) {
    await prepareAgentRuntime();
    assertUiGeneration(uiToken);
    const interruptedRuns = state.apps
      .filter((application) => application.autoRun && ['not_started', 'ready_to_fill'].includes(application.status) && application.tabId)
      .map((application) => application.id);
    if (interruptedRuns.length) void enqueueApplicationBatch(interruptedRuns);
  }

  async function submitModelProvider({ form, uiToken }) {
    await saveAgentProvider(form, uiToken);
    render();
    return SKIP_FINAL_RENDER;
  }

  const AGENT_CLICK_ACTIONS = [
    ['save-planner', savePlannerGateway],
    ['client-link', createClientLink],
    ['enable-agent', enableAgent],
  ];
  const AGENT_SUBMIT_ACTIONS = [
    ['model-provider-form', submitModelProvider],
  ];

  // Recertification caseload actions.

  function currentRecertification() {
    const item = recertificationById();
    if (!item) throw new Error('That recertification is no longer in the current caseload.');
    return item;
  }

  async function openRecertifications({ uiToken }) {
    await loadRecertifications(uiToken);
  }

  function reviewRecertification({ button }) {
    state.currentRecertificationId = decoded(button.dataset.recert);
    currentRecertification();
    state.view = 'recertification-detail';
  }

  async function draftRecertificationOutreach() {
    const item = currentRecertification();
    item.outreach = { ...item.outreach, status: 'drafted', completedAt: '' };
    await saveRecertificationWorkspace(item);
  }

  async function completeRecertificationOutreach() {
    const item = currentRecertification();
    item.outreach = { ...item.outreach, status: 'completed', completedAt: new Date().toISOString() };
    await saveRecertificationWorkspace(item);
  }

  async function prepareCurrentRecertification({ uiToken }) {
    await prepareRecertification(currentRecertification(), uiToken);
    return SKIP_FINAL_RENDER;
  }

  async function submitRecertificationIntake({ form }) {
    const item = currentRecertification();
    const data = new FormData(form);
    const recordedAt = new Date().toISOString();
    const requirements = Object.fromEntries(item.requirements.map((requirement) => {
      const status = String(data.get(`requirement-${requirement.key}`) || 'missing');
      const note = String(data.get(`note-${requirement.key}`) || '').replace(/\s+/g, ' ').trim().slice(0, 240);
      return [requirement.key, { status, note, confirmedAt: status === 'confirmed' ? recordedAt : '' }];
    }));
    const requestedConsent = String(data.get('consent') || 'not_asked');
    const consentStatus = requestedConsent === 'not_asked' && item.outreach.status !== 'not_started' ? 'invited' : requestedConsent;
    const updated = recertificationEngine.normalizeCase({
      ...item,
      requirements,
      consent: {
        status: consentStatus,
        recordedAt: ['authorized', 'declined'].includes(consentStatus) ? recordedAt : '',
      },
      outreach: item.outreach,
    });
    const index = state.recertifications.findIndex((candidate) => candidate.id === item.id);
    state.recertifications.splice(index, 1, updated);
    await saveRecertificationWorkspace(updated);
    state.currentRecertificationId = updated.id;
    state.view = 'recertification-detail';
    render();
    return SKIP_FINAL_RENDER;
  }

  const RECERTIFICATION_CLICK_ACTIONS = [
    ['open-recertifications', openRecertifications],
    ['back-recertifications', showScreen('recertifications')],
    ['review-recertification', reviewRecertification],
    ['draft-recertification-outreach', draftRecertificationOutreach],
    ['complete-recertification-outreach', completeRecertificationOutreach],
    ['prepare-recertification', prepareCurrentRecertification],
  ];
  const RECERTIFICATION_SUBMIT_ACTIONS = [
    ['recertification-intake-form', submitRecertificationIntake],
  ];

  // Client intake actions: choosing the client source, the programs, and returning home or ending the session.

  async function returnHome() {
    await cancelUiBoundRuns();
    const uiToken = cancelPendingUiWork();
    state.connectorDraft = null;
    state.connectorSchema = [];
    state.pendingConnectorRecord = null;
    state.documentResult = null;
    state.handoffApplicationId = null;
    state.view = canonicalHomeView();
    return { uiToken };
  }

  /** Stops every run, cancels pending screens, forgets the client and their applications, and clears the saved session. */
  async function endClientSession({ recordSessionEnd }) {
    cancelAllRuns();
    const uiToken = cancelPendingUiWork();
    if (recordSessionEnd) recordAudit('session_ended', null);
    state.participant = null;
    state.documentResult = null;
    state.pendingConnectorRecord = null;
    state.apps = [];
    state.currentAppId = null;
    state.previewPage = 1;
    state.view = 'choice';
    await clearAssistantState();
    return { uiToken };
  }

  async function changeClient() {
    return endClientSession({ recordSessionEnd: false });
  }

  async function startOver() {
    return endClientSession({ recordSessionEnd: true });
  }

  function openDocumentUpload() {
    state.documentResult = null;
    state.view = 'document';
  }

  function useSampleRecord() {
    document.getElementById('client-json').value = JSON.stringify(DEMO_RECORDS['339619'], null, 2);
    return SKIP_FINAL_RENDER;
  }

  async function submitRecordId({ form, uiToken }) {
    await lookupRecord(new FormData(form).get('recordId'), uiToken);
  }

  async function submitClientJson({ form, uiToken }) {
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

  async function submitClientDocument({ form, uiToken }) {
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

  async function submitDocumentReview({ form, uiToken }) {
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

  async function submitProgramChoice({ form, uiToken }) {
    const values = new FormData(form).getAll('program');
    if (!values.length) throw new Error('Choose at least one application or the current form.');
    await prepareAgentRuntime();
    assertUiGeneration(uiToken);
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
    return SKIP_FINAL_RENDER;
  }

  const INTAKE_CLICK_ACTIONS = [
    ['home', returnHome],
    ['choose-id', showScreen('record')],
    ['choose-json', showScreen('json')],
    ['choose-document', openDocumentUpload],
    ['back-choice', showScreen('choice')],
    ['back-document', openDocumentUpload],
    ['back-programs', showScreen('programs')],
    ['reload-source', showScreen('choice')],
    ['use-sample', useSampleRecord],
    ['change-client', changeClient],
    ['start-over', startOver],
  ];
  const INTAKE_SUBMIT_ACTIONS = [
    ['record-form', submitRecordId],
    ['json-form', submitClientJson],
    ['document-form', submitClientDocument],
    ['document-review-form', submitDocumentReview],
    ['program-form', submitProgramChoice],
  ];

  // Data-source connector actions: provider choice, settings, field mapping, and confirming a retrieved record.

  function configureConnector() {
    state.connectorDraft = null;
    state.connectorSchema = [];
    state.pendingConnectorRecord = null;
    state.view = managedConnector() ? 'connector' : 'providers';
  }

  function selectConnectorProvider({ button }) {
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

  /** Fills the connector form with the local mock connector's settings; the caseworker still reviews and submits it. */
  function fillLocalConnectorSettings() {
    const providerSelect = document.getElementById('connector-provider');
    providerSelect.value = 'apricot360';
    providerSelect.dispatchEvent(new Event('change', { bubbles: true }));
    document.getElementById('connector-org').value = 'Riverside Community Services';
    document.getElementById('connector-url').value = 'http://127.0.0.1:4789';
    document.getElementById('connection-id').value = 'nava-demo';
    document.getElementById('connector-source-id').value = '99';
    return SKIP_FINAL_RENDER;
  }

  async function resetConnector({ uiToken }) {
    setBusy('Disconnecting the data source…');
    await withCoordinatorMutation(async () => {
      const response = await sendRuntime({ type: 'RESET_CONNECTOR', sessionEpoch: state.sessionEpoch });
      await reconcileConnectorMutation(response, uiToken, 'choice');
    });
  }

  function backToRecordId() {
    state.pendingConnectorRecord = null;
    state.view = 'record';
  }

  async function confirmConnectorRecord({ uiToken }) {
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

  /** The submitted connector settings. Resubmitting the saved source keeps its reviewed mappings under the next mapping version. */
  function connectorConfigFromForm(data) {
    const submittedIdentity = {
      provider: String(data.get('provider') || '').trim(),
      backendUrl: String(data.get('backendUrl') || '').trim(),
      connectionId: String(data.get('connectionId') || '').trim(),
      sourceId: String(data.get('sourceId') || '').trim(),
    };
    const sameMappedSource = managedConnector()
      && ['provider', 'backendUrl', 'connectionId', 'sourceId']
        .every((key) => String(state.connector[key] || '').trim() === submittedIdentity[key]);
    return {
      ...submittedIdentity,
      organizationName: String(data.get('organizationName') || '').trim(),
      maxAgeDays: Number(data.get('maxAgeDays')),
      mappings: sameMappedSource ? state.connector.mappings : {},
      mappingVersion: sameMappedSource ? Number(state.connector.mappingVersion || 1) + 1 : 1,
    };
  }

  async function submitConnectorSettings({ form, uiToken }) {
    const config = connectorConfigFromForm(new FormData(form));
    setBusy('Testing the connector and loading labeled fields…');
    const response = await sendRuntime({ type: 'DISCOVER_CONNECTOR', config });
    assertUiGeneration(uiToken);
    if (!response?.ok) throw new Error(response?.error || 'The connector could not be verified.');
    state.connectorDraft = { ...response.config, mappings: response.suggestions || {} };
    state.connectorSchema = response.schema || [];
    state.view = 'connector-mapping';
  }

  async function submitConnectorMapping({ form, uiToken }) {
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

  const CONNECTOR_CLICK_ACTIONS = [
    ['configure-connector', configureConnector],
    ['back-providers', showScreen('providers')],
    ['select-provider', selectConnectorProvider],
    ['back-connector', showScreen('connector')],
    ['local-connector-settings', fillLocalConnectorSettings],
    ['reset-connector', resetConnector],
    ['back-record-id', backToRecordId],
    ['confirm-connector-record', confirmConnectorRecord],
  ];
  const CONNECTOR_SUBMIT_ACTIONS = [
    ['connector-form', submitConnectorSettings],
    ['connector-mapping-form', submitConnectorMapping],
  ];

  // Application actions: the dashboard, each application card, handoffs, and answers to open questions.

  /** Card buttons name their application in data-app. It must still exist, and it becomes the current application. */
  function cardApplication(button) {
    const id = decoded(button.dataset.app);
    const application = state.apps.find((item) => item.id === id);
    if (!application) throw new Error('That application is no longer available.');
    state.currentAppId = id;
    return application;
  }

  function forCardApplication(handler) {
    return (context) => handler(cardApplication(context.button), context);
  }

  /** A caseworker-started run: a new run token bound to this screen, holding the application's write lease throughout. */
  function withLeasedUiRun(application, step) {
    return withNewApplicationRun(
      application,
      (runToken) => withApplicationLease(application, () => step(runToken)),
      { uiBound: true },
    );
  }

  function answerCardQuestions(application, { action }) {
    application.autoRun = action === 'answer-run';
    state.view = 'questions';
  }

  async function fillCardApplication(application) {
    await withLeasedUiRun(application, (runToken) => fillApplication(application, [], [], { runToken }));
  }

  async function runCardApplicationInDashboard(application) {
    state.view = 'dashboard';
    render();
    await withLeasedUiRun(application, (runToken) => runThroughApplication(application, [], [], { background: true, runToken }));
  }

  async function scanCardApplication(application, { uiToken }) {
    const tab = previewMode ? { id: application.tabId, url: application.url } : await chrome.tabs.get(application.tabId);
    assertUiGeneration(uiToken);
    await scanTab(tab, { applicationId: application.id, uiToken });
  }

  async function resumeCardApplication(application, { action }) {
    await withLeasedUiRun(application, (runToken) => resumeApplication(application, action === 'resume-current', { runToken }));
  }

  async function resumeCardAfterHumanCheckpoint(application) {
    await withLeasedUiRun(application, (runToken) => resumeHumanCheckpoint(application, { runToken }));
  }

  async function openCardHandoff(application) {
    await revokeApplicationRun(application);
    setCheckpoint(application, 'voluntary_pause', 'Paused while caseworker chooses a handoff', 'paused');
    state.handoffApplicationId = application.id;
    state.view = 'handoff';
    await persist({ applicationIds: [application.id] });
  }

  async function pauseCardApplication(application) {
    await revokeApplicationRun(application);
    setCheckpoint(application, 'voluntary_pause', 'Paused by caseworker', 'paused');
    state.handoffApplicationId = null;
    state.view = 'dashboard';
    await persist({ applicationIds: [application.id] });
  }

  async function acceptCardHandoff(application) {
    const acceptedAt = new Date().toISOString();
    application.handoff = { ...application.handoff, acceptedAt };
    application.owner = { ...application.owner, state: 'active', assignedAt: application.owner?.assignedAt || acceptedAt };
    application.status = 'paused';
    application.checkpoint = checkpoint('voluntary_pause', 'Handoff accepted; verify page before resuming');
    application.updatedAt = acceptedAt;
    recordAudit('handoff_accepted', application, { actor: application.owner?.assignedTo, toStatus: 'paused' });
    await persist({ applicationIds: [application.id] });
  }

  async function goToCardTab(application) {
    await goToApplication(application);
  }

  const APPLICATION_CARD_ACTIONS = [
    ['answer', answerCardQuestions],
    ['answer-run', answerCardQuestions],
    ['fill', fillCardApplication],
    ['run', runCardApplicationInDashboard],
    ['review', showScreen('review')],
    ['rescan', scanCardApplication],
    ['go-tab', goToCardTab],
    ['scan-application', scanCardApplication],
    ['resume', resumeCardApplication],
    ['resume-current', resumeCardApplication],
    ['resume-human-checkpoint', resumeCardAfterHumanCheckpoint],
    ['open-handoff', openCardHandoff],
    ['pause', pauseCardApplication],
    ['accept-handoff', acceptCardHandoff],
  ];

  function backToDashboard() {
    state.handoffApplicationId = null;
    state.view = 'dashboard';
  }

  async function addApplication({ uiToken }) {
    const activeTab = await getActiveTab();
    assertUiGeneration(uiToken);
    state.activeTab = activeTab;
    state.view = 'programs';
  }

  async function exportAudit({ uiToken }) {
    await exportAuditLog(uiToken);
    return SKIP_FINAL_RENDER;
  }

  async function analyzeCurrentTab({ uiToken }) {
    const activeTab = await getActiveTab();
    assertUiGeneration(uiToken);
    state.activeTab = activeTab;
    await scanTab(state.activeTab, { uiToken });
  }

  async function submitHandoff({ form, uiToken }) {
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

  /** A multi-select answer fans out to an explicit yes or no for every checkbox member; null leaves the question open. */
  function multiChoiceAssignments(gap, selected) {
    const noneSelected = selected.includes('__none__');
    const chosen = new Set(selected.filter((value) => value !== '__none__'));
    if (!selected.length || (noneSelected && chosen.size)) return null;
    return (gap.members || []).map((member) => ({
      fieldKey: member.fieldKey,
      label: member.label,
      purpose: member.purpose,
      value: noneSelected || !chosen.has(member.fieldKey) ? 'no' : 'yes',
      source: 'user',
      detail: 'Your answer in this browser session',
      sensitive: Boolean(member.sensitive),
    }));
  }

  /** A typed answer becomes one assignment; a blank answer (null) leaves the question open. */
  function typedAnswerAssignments(gap, answer) {
    if (!answer) return null;
    return [{
      fieldKey: gap.fieldKey,
      label: gap.label,
      purpose: gap.purpose,
      value: answer,
      source: 'user',
      detail: 'Your answer in this browser session',
      sensitive: gap.sensitive,
    }];
  }

  /** Reads the questions form (answer-<gap index> fields) into user assignments and the gaps still unanswered. */
  function answersFromQuestionsForm(gaps, data) {
    const userAssignments = [];
    const unresolved = [];
    gaps.forEach((gap, index) => {
      const assignments = gap.inputType === 'multi_choice'
        ? multiChoiceAssignments(gap, data.getAll(`answer-${index}`).map((value) => String(value)))
        : typedAnswerAssignments(gap, String(data.get(`answer-${index}`) || '').trim());
      if (assignments) userAssignments.push(...assignments);
      else unresolved.push(gap);
    });
    return { userAssignments, unresolved };
  }

  async function submitQuestionAnswers({ form }) {
    const application = state.apps.find((item) => item.id === state.currentAppId);
    if (!application) throw new Error('That application is no longer available.');
    const { userAssignments, unresolved } = answersFromQuestionsForm(application.analysis?.gaps || [], new FormData(form));
    if (application.autoRun) {
      state.view = 'dashboard';
      render();
      await withLeasedUiRun(
        application,
        (runToken) => runThroughApplication(application, userAssignments, unresolved, { background: true, runToken }),
      );
    }
    else {
      await withLeasedUiRun(
        application,
        (runToken) => fillApplication(application, userAssignments, unresolved, { runToken }),
      );
    }
  }

  const APPLICATION_CLICK_ACTIONS = [
    ...APPLICATION_CARD_ACTIONS.map(([action, handler]) => [action, forCardApplication(handler)]),
    ['back-dashboard', backToDashboard],
    ['add-application', addApplication],
    ['export-audit', exportAudit],
    ['analyze-current', analyzeCurrentTab],
  ];
  const APPLICATION_SUBMIT_ACTIONS = [
    ['handoff-form', submitHandoff],
    ['questions-form', submitQuestionAnswers],
  ];

  // Own-property tables: a Map never resolves prototype keys such as 'toString'. Unknown actions and forms only re-render.
  const CLICK_ACTIONS = new Map([
    ...AGENT_CLICK_ACTIONS,
    ...RECERTIFICATION_CLICK_ACTIONS,
    ...INTAKE_CLICK_ACTIONS,
    ...CONNECTOR_CLICK_ACTIONS,
    ...APPLICATION_CLICK_ACTIONS,
  ]);
  const SUBMIT_ACTIONS = new Map([
    ...AGENT_SUBMIT_ACTIONS,
    ...RECERTIFICATION_SUBMIT_ACTIONS,
    ...INTAKE_SUBMIT_ACTIONS,
    ...CONNECTOR_SUBMIT_ACTIONS,
    ...APPLICATION_SUBMIT_ACTIONS,
  ]);

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
    if (event.target.id === 'model-provider') {
      const fields = document.getElementById('model-companion-fields');
      if (fields) fields.hidden = event.target.value === 'chrome-local';
      return;
    }
    if (event.target.id === 'connector-provider') {
      const provider = connectorEngine.providerDefinition(event.target.value);
      if (!provider) return;
      const sourceLabel = document.querySelector('label[for="connector-source-id"]');
      const sourceInput = document.getElementById('connector-source-id');
      if (sourceLabel) sourceLabel.textContent = provider.sourceLabel;
      if (sourceInput) sourceInput.placeholder = provider.sourceLabel;
    }
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
      if (!previewMode && chrome.storage?.local?.get) {
        const stored = await chrome.storage.local.get(['navaApiBase']);
        state.plannerBase = String(stored?.navaApiBase || '');
      }
      await restoreAgentProvider();
      state.activeTab = await getActiveTab();
      assertUiGeneration(uiToken);
      loadPreviewQueueFixture();
      await loadPreviewDocumentFixture(uiToken);
      assertUiGeneration(uiToken);
      if (!previewMode && agentPlanner?.availability) {
        const availability = await agentPlanner.availability();
        state.agentRuntime = {
          status: availability === 'available' ? 'available' : availability,
          message: availability === 'available' ? 'The on-device model is available.' : '',
        };
      }
      render();
    } catch (error) {
      if (error?.name === 'UiCancelledError' || uiToken !== uiGeneration) return;
      state.error = error.message;
      state.view = 'choice';
      render();
    }
  }

  bootstrap();
})();
