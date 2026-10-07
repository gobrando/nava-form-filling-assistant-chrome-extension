// Page scan: approves the tab's location, reads the page through NAVA_SCAN, plans it with the agentic planner, and stores the scanned application and its audit.
(function installPageScan(root) {
  'use strict';

  /**
   * deps:
   * - state, previewMode: panel state and whether the panel runs without extension APIs.
   * - engine, agentPlanner, scanAnalysis: the form engine, the agentic planner, and NavaScanAnalysis.
   * - scanRecord: scanAnalysis.create(...) bound to the URL and provenance helpers.
   * - sendToTab(tab, message, options): the route-checked tab command transport.
   * - assertApprovedApplicationLocation, attachApplicationPolicy, urlPath, commandLocation, checkpointFromScan: route and checkpoint policy.
   * - assertApplicationRun, cancelApplicationRun, assertUiGeneration: run-token and screen-generation guards.
   * - setCheckpoint, recordAudit, persist, newWorkflowId: queue state, audit and coordinator persistence.
   * - setBusy, setApplicationProgress, agentProgressMessage, prepareAgentRuntime: progress display and planner start-up.
   * - mergeVerifiedProvenance, mergeAgenticMetadata: panel-format merges.
   */
  function create(deps) {
    const {
      state,
      previewMode,
      engine,
      agentPlanner,
      scanAnalysis,
      scanRecord,
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
    } = deps;

    /**
     * Scans one tab in five steps. Route approval always precedes the NAVA_SCAN that carries client data,
     * and the stored application is checked against the run token before it is persisted.
     */
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
      const target = resolveScanTarget(tab, applicationId, runToken);
      const participant = scanAnalysis.participantForApplication(state.participant, target.previous);
      const response = await requestPageScan(tab, target, participant, runToken);
      const observedUrl = checkScanResponse(tab, target, response, { runToken, uiToken, expectedCommandLocation });
      const planned = await planScannedPage(response, target, participant);
      return storeScannedApplication({ tab, target, response, observedUrl, planned }, { quiet, runToken, uiToken, preservePageProgress });
    }

    /**
     * Step 1. A requested application must still be on its approved location under the current run token.
     * A tab-bound application whose page changed is detached before any client data is read or written.
     */
    function resolveScanTarget(tab, applicationId, runToken) {
      const requestedApplication = applicationId ? state.apps.find((item) => item.id === applicationId) : null;
      if (requestedApplication) {
        assertApprovedApplicationLocation(requestedApplication, tab.url);
        assertApplicationRun(requestedApplication, runToken);
        return { requestedApplication, previous: requestedApplication };
      }
      const tabApplication = state.apps.find((item) => item.tabId === tab.id);
      if (!tabApplication) return { requestedApplication: null, previous: {} };
      try {
        assertApprovedApplicationLocation(tabApplication, tab.url);
        if (urlPath(tabApplication.url) !== urlPath(tab.url)) throw new Error('This tab now shows a different application page.');
        return { requestedApplication: null, previous: tabApplication };
      } catch {
        detachChangedTabApplication(tabApplication);
        return { requestedApplication: null, previous: {} };
      }
    }

    function detachChangedTabApplication(tabApplication) {
      cancelApplicationRun(tabApplication);
      tabApplication.tabId = null;
      tabApplication.runStopReason = 'The tab navigated to a different page. The saved workflow was detached before any client data was read or written.';
      setCheckpoint(tabApplication, 'page_changed', 'Application tab changed', 'paused');
    }

    /** The application a scan reports progress to and binds its command to, when it already has one. */
    function boundApplication(target) {
      return target.requestedApplication || (target.previous.id ? target.previous : null);
    }

    /** Step 2. Sends NAVA_SCAN through the route-checked transport; a run token requires the write lease. */
    function requestPageScan(tab, target, participant, runToken) {
      return sendToTab(
        tab,
        { type: 'NAVA_SCAN', participant },
        { application: boundApplication(target), requireLease: Boolean(runToken) },
      );
    }

    /** Step 3. Rejects a failed or stale scan and a page that moved, then re-approves the observed URL. */
    function checkScanResponse(tab, target, response, { runToken, uiToken, expectedCommandLocation }) {
      if (uiToken !== null) assertUiGeneration(uiToken);
      if (!response?.ok) throw new Error(response?.error || 'The form could not be read.');
      assertApplicationRun(target.requestedApplication || target.previous, runToken);
      const observedUrl = response.page?.url || tab.url;
      if (expectedCommandLocation && commandLocation(observedUrl) !== expectedCommandLocation) {
        throw new Error('The application navigated while the assistant was checking for conditional fields. It paused without advancing again.');
      }
      if (target.requestedApplication) {
        assertApprovedApplicationLocation(target.requestedApplication, observedUrl);
      }
      return observedUrl;
    }

    /** Step 4. Plans the page with the agentic planner; the simulated preview keeps the page agent's own analysis. */
    async function planScannedPage(response, target, participant) {
      const { previous } = target;
      if (previewMode) return { analysis: response.analysis, agentic: previous.agentic || null, usage: null };
      if (!Array.isArray(response.fields)) throw new Error('The page agent did not provide a safe field inventory for AI planning. Reload the extension before continuing.');
      const progressApplication = boundApplication(target);
      await prepareAgentRuntime({ application: progressApplication });
      const plan = await agentPlanner.plan({
        engine,
        page: response.page,
        rawFields: response.fields,
        participant,
        onProgress(update) {
          const message = agentProgressMessage(update);
          if (progressApplication) setApplicationProgress(progressApplication, message);
          else setBusy(message);
        },
      });
      return {
        analysis: scanAnalysis.analysisFromAgentPlan(engine, response, participant, plan),
        agentic: mergeAgenticMetadata(previous.agentic, plan.metadata),
        usage: plan.metadata.usage || null,
      };
    }

    function upsertApplication(application) {
      const existing = state.apps.findIndex((item) => item.id === application.id);
      if (existing >= 0) state.apps.splice(existing, 1, application);
      else state.apps.unshift(application);
    }

    /** Step 5. Stores the scanned application, audits the scan, and persists it under the run token. */
    async function storeScannedApplication({ tab, target, response, observedUrl, planned }, { quiet, runToken, uiToken, preservePageProgress }) {
      const { previous } = target;
      const id = previous.id || newWorkflowId();
      const analysis = {
        ...planned.analysis,
        observed: mergeVerifiedProvenance(planned.analysis?.observed || []),
      };
      const nextCheckpoint = checkpointFromScan({ ...response, analysis }, analysis.counts?.fields || 0);
      const application = attachApplicationPolicy(scanRecord.scannedApplication({
        previous,
        id,
        tab,
        response,
        observedUrl,
        analysis,
        agentic: planned.agentic,
        checkpoint: nextCheckpoint,
        preservePageProgress,
      }));
      upsertApplication(application);
      recordAudit('scan_completed', application, scanAnalysis.scanAuditDetails({
        analysis,
        agentic: planned.agentic,
        usage: planned.usage,
        checkpointKind: nextCheckpoint?.kind,
        status: application.status,
      }));
      if (analysis.gaps?.length) {
        recordAudit('questions_required', application, { gapCount: analysis.gaps.length, checkpointKind: 'human_input' });
      }
      state.currentAppId = id;
      if (!quiet) state.view = 'dashboard';
      assertApplicationRun(application, runToken);
      if (uiToken !== null) assertUiGeneration(uiToken);
      await persist({ applicationIds: [id], includeCurrentAppId: !quiet });
      return application;
    }

    return { scanTab };
  }

  const api = { create };

  root.NavaPageScan = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
