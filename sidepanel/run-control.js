// Run control: one run token per application, the session and UI generations that outdate runs and screens, the stop errors, and cancellation (NAVA_CANCEL goes only to a tab whose lease this window holds).
(function installRunControl(root) {
  'use strict';

  /**
   * deps:
   * - state, previewMode: panel state (apps, sessionEpoch, workerId) and whether the panel runs without extension APIs.
   * - checkpoint(kind, label): the application-policy checkpoint for UI-bound runs paused when the assistant returns home.
   * - revokeApplicationRun(application): the coordinator revoke; a lazy wrapper, because coordinator writes are created later.
   * - onCancelAll(): clears the automatic run queue and its retry timers once every run is cancelled; a lazy wrapper, because
   *   automatic runs are created later.
   */
  function create(deps) {
    const {
      state,
      previewMode,
      checkpoint,
      revokeApplicationRun,
      onCancelAll,
    } = deps;
    const activeRunTokens = new Map();
    let sessionGeneration = 0;
    let uiGeneration = 0;

    // Read-through accessors: other modules see the live UI generation and run tokens, never a copy taken at creation.

    function currentUiGeneration() {
      return uiGeneration;
    }

    // True from the start of a run until it settles, including while a cancelled run winds down (new runs wait for it).
    function isRunning(applicationId) {
      return activeRunTokens.has(applicationId);
    }

    // What the caseworker should see: a run that has been cancelled is no longer "running", even before it settles.
    function runActive(applicationId) {
      const token = activeRunTokens.get(applicationId);
      return Boolean(token && !token.cancelled);
    }

    function activeRun(applicationId) {
      return activeRunTokens.get(applicationId);
    }

    function activeRunCount() {
      return activeRunTokens.size;
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
      onCancelAll();
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

    return {
      currentUiGeneration,
      isRunning,
      runActive,
      activeRun,
      activeRunCount,
      runCancelledError,
      coordinatorStaleError,
      leaseConflictError,
      uiCancelledError,
      cancelPendingUiWork,
      assertUiGeneration,
      beginApplicationRun,
      assertApplicationRun,
      endApplicationRun,
      withNewApplicationRun,
      cancelApplicationRun,
      cancelAllRuns,
      cancelUiBoundRuns,
    };
  }

  const api = { create };

  root.NavaRunControl = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
