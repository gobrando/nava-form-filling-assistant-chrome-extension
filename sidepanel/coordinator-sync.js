// Coordinator sync: keeps this window in step with the service-worker coordinator — control metadata, full and targeted syncs, syncs deferred while a coordinator mutation is in flight, and the start-up restore.
(function installCoordinatorSync(root) {
  'use strict';

  /**
   * deps:
   * - state, previewMode: panel state and whether the panel runs without extension APIs (preview defers every sync).
   * - workQueueEngine, attachApplicationPolicy: restore saved applications and re-attach their route policy.
   * - requestAssistantState(): the coordinator's session, queue and control metadata.
   * - cancelApplicationRun(application), cancelAllRuns(): run control, for applications or sessions changed elsewhere.
   * - coordinatorStaleError(message): the stop error when the coordinator keeps changing.
   * - controlDiffersFromCoordinator, mergeApplicationsWithCoordinator, mergeAuditWithCoordinator, currentApplicationAfterSync:
   *   the coordinator merge rules.
   * - canonicalHomeView(), render(): the home screen for the current session, and the screen renderer.
   */
  function create(deps) {
    const {
      state,
      previewMode,
      workQueueEngine,
      attachApplicationPolicy,
      requestAssistantState,
      cancelApplicationRun,
      cancelAllRuns,
      coordinatorStaleError,
      controlDiffersFromCoordinator,
      mergeApplicationsWithCoordinator,
      mergeAuditWithCoordinator,
      currentApplicationAfterSync,
      canonicalHomeView,
      render,
    } = deps;
    let coordinatorMutationDepth = 0;
    let coordinatorSyncPending = false;
    let coordinatorSyncPromise = null;
    let pendingCoordinatorSnapshot = null;
    const pendingApplicationSyncIds = new Set();

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

    /** True while a coordinator sync is in flight. Callers ask at the moment they act; the answer is never stored. */
    function coordinatorSyncRunning() {
      return Boolean(coordinatorSyncPromise);
    }

    return {
      applicationGenerations,
      applicationRevisions,
      applyCoordinatorMetadata,
      withCoordinatorMutation,
      restore,
      coordinatorDelta,
      observeCoordinator,
      scheduleCoordinatorSync,
      waitForCoordinatorSync,
      coordinatorSyncRunning,
    };
  }

  const api = { create };

  root.NavaCoordinatorSync = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
