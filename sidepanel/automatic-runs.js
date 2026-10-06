// Automatic runs: opens the chosen program tabs and takes each tab-bound application through the runner in a bounded worker pool, retrying after coordinator changes and lease conflicts.
(function installAutomaticRuns(root) {
  'use strict';

  const MAX_PARALLEL_APPLICATIONS = 3;
  const TAB_READY_TIMEOUT_MS = 60_000;

  /**
   * deps:
   * - state, previewMode: panel state and whether the panel runs without extension APIs.
   * - sendRuntime(message), newWorkflowId(), recordAudit(type, application, details): transport, ids and the audit log.
   * - activeRun(id), isRunning(id), beginApplicationRun, assertApplicationRun, endApplicationRun: run control, read at call time.
   * - APPLICATION_LEASE_MS, withApplicationLease(application, action), persist(options): coordinator writes.
   * - scheduleCoordinatorSync(ids), waitForCoordinatorSync(): coordinator sync.
   * - probeTabDocument(tabId), ensurePageAgent(tab, documentId): tab document binding and page-agent injection.
   * - assertApprovedApplicationLocation, assertSameDocumentLocation: the application route policy.
   * - scanTab(tab, options), runThroughApplication(application, assignments, unresolved, options): the write path.
   * - setApplicationProgress, setCheckpoint, render, renderDashboardIfVisible: queue state and the dashboard.
   */
  function create(deps) {
    const {
      state,
      previewMode,
      sendRuntime,
      newWorkflowId,
      recordAudit,
      activeRun,
      isRunning,
      beginApplicationRun,
      assertApplicationRun,
      endApplicationRun,
      APPLICATION_LEASE_MS,
      withApplicationLease,
      persist,
      scheduleCoordinatorSync,
      waitForCoordinatorSync,
      probeTabDocument,
      ensurePageAgent,
      assertApprovedApplicationLocation,
      assertSameDocumentLocation,
      scanTab,
      runThroughApplication,
      setApplicationProgress,
      setCheckpoint,
      render,
      renderDashboardIfVisible,
    } = deps;
    let automaticWorkersActive = 0;
    const leaseRetryTimers = new Map();
    const coordinatorRetryIds = new Set();
    const automaticRunQueue = [];
    const queuedAutomaticApplicationIds = new Set();

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
      const existingRun = activeRun(applicationId);
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
        if (!eligibleAutomaticApplication(application) || isRunning(applicationId)) return;
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

    /** Forgets queued applications and pending retries. Run control calls it after cancelling every run. */
    function clear() {
      leaseRetryTimers.forEach((timer) => clearTimeout(timer));
      leaseRetryTimers.clear();
      coordinatorRetryIds.clear();
      automaticRunQueue.splice(0);
      queuedAutomaticApplicationIds.clear();
    }

    return {
      openSelectedPrograms,
      waitForApplicationTab,
      runQueuedApplication,
      eligibleAutomaticApplication,
      enqueueApplicationBatch,
      clear,
    };
  }

  const api = { create };

  root.NavaAutomaticRuns = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
