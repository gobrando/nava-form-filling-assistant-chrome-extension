// Application runner: fills and verifies one page, waits for the next page, drives the multi-page run to a human checkpoint, and resumes paused or human-verified applications. It never submits.
(function installApplicationRunner(root) {
  'use strict';

  // How one fill pass ends: the run stopped for a person, the same page must be filled again, or the page is done.
  const STOPPED = 'stopped';
  const FILL_AGAIN = 'fill-again';
  const PAGE_DONE = 'page-done';

  /** The URL of the page the application is on: the last scanned page, else the URL it was opened at. */
  function currentPageUrl(application) {
    return application.page?.url || application.url;
  }

  /** The 1-based number of the page the run is working on. */
  function pageNumber(application) {
    return (application.completedPages?.length || 0) + 1;
  }

  /**
   * deps:
   * - state, previewMode: panel state and whether the panel runs without extension APIs.
   * - workQueueEngine, scanAnalysis: resume hashing and decisions; the participant a scan sends.
   * - MAX_SAME_PAGE_FILL_PASSES, NAVIGATION_TIMEOUT_MS: run limits declared by the side panel.
   * - sendToTab, scanTab, getActiveTab: route-checked tab commands, the page scan, and the active-tab lookup.
   * - assertApprovedApplicationLocation, assertSameDocumentLocation, urlOrigin, urlPath, commandLocation,
   *   automatedPageLimit, stopCheckpoint, pendingHumanCheck: route and checkpoint policy.
   * - assertApplicationRun, runCancelledError, renewApplicationLease: run-token and write-lease guards.
   * - setCheckpoint, recordAudit, persist: queue state, audit and coordinator persistence.
   * - setBusy, setApplicationProgress, mergeVerifiedProvenance: progress display and provenance merging.
   */
  function create(deps) {
    const {
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
      stopCheckpoint,
      pendingHumanCheck,
      assertApplicationRun,
      runCancelledError,
      renewApplicationLease,
      setCheckpoint,
      recordAudit,
      persist,
      setBusy,
      setApplicationProgress,
      mergeVerifiedProvenance,
    } = deps;

    /** Fills one page through NAVA_FILL on its approved location and records the verified read-back. */
    async function fillCurrentPage(application, userAssignments = [], unresolved = [], { background = false, runToken = null } = {}) {
      assertApplicationRun(application, runToken);
      const tab = previewMode
        ? { id: application.tabId, url: application.url }
        : await chrome.tabs.get(application.tabId);
      assertApprovedApplicationLocation(application, tab.url);
      if (background) {
        setApplicationProgress(application, `Filling and verifying page ${pageNumber(application)}…`);
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
      recordFillResults(application, response, unresolved);
      recordAudit('page_verified', application, {
        verifiedCount: (response.results || []).filter((item) => item.status === 'verified').length,
        blockedCount: application.blocked.length,
        gapCount: unresolved.length,
        pageCount: pageNumber(application),
        toStatus: application.status,
      });
      state.currentAppId = application.id;
      assertApplicationRun(application, runToken);
      await persist({ applicationIds: [application.id] });
      return response;
    }

    /** Merges the verified provenance, lists blocked and unanswered fields, and sets the page's checkpoint. */
    function recordFillResults(application, response, unresolved) {
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
    }

    function archiveCurrentPage(application) {
      const url = currentPageUrl(application);
      const title = application.page?.title || application.name;
      const signature = application.navigationGate?.pageSignature || `${url}|${title}`;
      if (application.completedPages?.some((page) => page.signature === signature)) return;
      application.completedPages = [
        ...(application.completedPages || []),
        {
          signature,
          title,
          url,
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

    /** Polls the tab until a new page signature holds steady, within the one-minute navigation timeout. */
    async function waitForNextPage(application, previousSignature, runToken) {
      const tabId = application.tabId;
      if (previewMode) return { id: tabId, url: `https://benefitscal.com/ApplyForBenefits/step-${state.previewPage}` };
      const startedAt = Date.now();
      const previousLocation = commandLocation(currentPageUrl(application));
      const benefitsCalOverview = application.workflowId === 'benefitscal'
        && urlPath(currentPageUrl(application)).toLowerCase() === '/applyforbenefits/begin/abovr';
      const candidate = { signature: '', since: 0 };
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
          if (settledOnNewPage(candidate, gate, previousSignature)) return tab;
        } catch {
          candidate.signature = '';
          candidate.since = 0;
          // Full-page navigations briefly disconnect the content agent. Keep polling.
        }
      }
      throw new Error('The site did not reach a stable new page within one minute after the approved continuation control was activated. The assistant stopped so the caseworker can inspect the application.');
    }

    /** Tracks a candidate page signature: true once a new one has held for 500 ms; a missing or old one resets it. */
    function settledOnNewPage(candidate, gate, previousSignature) {
      if (!gate?.pageSignature || gate.pageSignature === previousSignature) {
        candidate.signature = '';
        candidate.since = 0;
        return false;
      }
      if (gate.pageSignature !== candidate.signature) {
        candidate.signature = gate.pageSignature;
        candidate.since = Date.now();
        return false;
      }
      return Date.now() - candidate.since >= 500;
    }

    async function rescanCurrentPageAfterFill(application, runToken) {
      if (previewMode) return null;
      assertApplicationRun(application, runToken);
      const expectedLocation = commandLocation(currentPageUrl(application));
      const tab = await chrome.tabs.get(application.tabId);
      assertApprovedApplicationLocation(application, tab.url);
      assertSameDocumentLocation(currentPageUrl(application), tab.url);
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

    /**
     * Runs an application page by page until a stop rule hands it to a person. Every pass renews the write lease,
     * fills and verifies the page, and advances only through an approved continuation control. It never submits.
     */
    async function runThroughApplication(application, userAssignments = [], unresolved = [], { background = false, runToken = null } = {}) {
      assertApplicationRun(application, runToken);
      application.autoRun = true;
      application.runStopReason = '';
      await persist({ applicationIds: [application.id] });
      const run = {
        current: application,
        suppliedAssignments: userAssignments,
        suppliedUnresolved: unresolved,
        samePageFillPasses: 0,
        background,
        runToken,
      };

      for (;;) {
        assertApplicationRun(run.current, runToken);
        await renewApplicationLease(run.current, runToken);
        const pageOutcome = await fillPageStep(run);
        if (pageOutcome === STOPPED) return;
        if (pageOutcome === FILL_AGAIN) continue;
        const tab = await continuationTab(run);
        if (!tab) return;
        if (await stopAtPageLimit(run) || await stopAtRepeatedPage(run)) return;
        run.current = await advanceToNextPage(run, tab);
        run.samePageFillPasses = 0;
      }
    }

    /**
     * Fills the known and supplied values and verifies them. Stop rules: no assignments but open questions;
     * blocked or empty fields after a fill; conditional fields still appearing after MAX_SAME_PAGE_FILL_PASSES.
     */
    async function fillPageStep(run) {
      const { current, suppliedAssignments, suppliedUnresolved, background, runToken } = run;
      const scannedGaps = current.analysis?.gaps || [];
      const hasSuppliedAnswers = suppliedAssignments.length > 0 || suppliedUnresolved.length > 0;
      const unresolvedForFill = hasSuppliedAnswers ? suppliedUnresolved : scannedGaps;
      const assignmentCount = (current.analysis?.assignments?.length || 0) + suppliedAssignments.length;

      if (!assignmentCount && unresolvedForFill.length) return stopForAnswers(run);

      // Caseworker answers apply to the first fill of this page only.
      run.suppliedAssignments = [];
      run.suppliedUnresolved = [];
      if (!assignmentCount) return PAGE_DONE;

      await fillCurrentPage(current, suppliedAssignments, unresolvedForFill, { background, runToken });
      run.samePageFillPasses += 1;
      if (current.empty.length || current.blocked.length) return stopAfterIncompleteFill(run);
      return checkConditionalFields(run);
    }

    /** Shows the stop screen when a person started the run, then saves the stopped application. */
    async function saveStop(run, view) {
      if (!run.background) state.view = view;
      await persist({ applicationIds: [run.current.id] });
      return STOPPED;
    }

    /** Stop rule: nothing to write but questions remain open. */
    function stopForAnswers(run) {
      setCheckpoint(run.current, 'human_input', 'Caseworker answers required', 'needs_attention');
      state.currentAppId = run.current.id;
      return saveStop(run, 'questions');
    }

    /** Stop rule: the fill left a field blocked or unanswered. */
    function stopAfterIncompleteFill(run) {
      run.current.runStopReason = 'The automated run paused after filling the known values because at least one field needs a caseworker answer or direct entry.';
      return saveStop(run, 'dashboard');
    }

    /** Rescans the filled page; new conditional work is filled again up to MAX_SAME_PAGE_FILL_PASSES times. */
    async function checkConditionalFields(run) {
      const rescanned = await rescanCurrentPageAfterFill(run.current, run.runToken);
      if (!rescanned) return PAGE_DONE;
      run.current = rescanned;
      const hasConditionalWork = Boolean(
        rescanned.analysis?.assignments?.length || rescanned.analysis?.gaps?.length,
      );
      if (!hasConditionalWork) return PAGE_DONE;
      if (run.samePageFillPasses >= MAX_SAME_PAGE_FILL_PASSES) return stopForConditionalFields(run);
      return FILL_AGAIN;
    }

    /** Stop rule: the page kept revealing fields after the same-page fill limit. */
    function stopForConditionalFields(run) {
      const { current } = run;
      current.runStopReason = `The page revealed more fields after ${MAX_SAME_PAGE_FILL_PASSES} verified fill passes. The assistant stopped before advancing.`;
      current.error = current.runStopReason;
      setCheckpoint(current, 'navigation_unknown', 'Conditional fields require review', 'needs_attention');
      state.currentAppId = current.id;
      return saveStop(run, 'dashboard');
    }

    /** Re-approves the tab and reads its continuation control; null after the navigation-gate stop rule. */
    async function continuationTab(run) {
      const { current, runToken } = run;
      const tab = previewMode
        ? { id: current.tabId, url: current.url }
        : await chrome.tabs.get(current.tabId);
      assertApprovedApplicationLocation(current, tab.url);
      assertApplicationRun(current, runToken);
      current.navigationGate = await navigationStatusFor(tab, current);
      assertApplicationRun(current, runToken);
      if (current.navigationGate?.kind === 'next') return tab;
      await stopAtNavigationGate(run);
      return null;
    }

    /** Stop rule: the navigation gate is not 'next'. Signature, certification and final-review stops go to review. */
    async function stopAtNavigationGate(run) {
      const { current, runToken } = run;
      current.runStopReason = current.navigationGate?.reason || 'No approved continuation control is visible. Review the application before taking the next action.';
      const stop = applyStopCheckpoint(current, `${current.navigationGate?.text || ''} ${current.runStopReason}`, 'Human final review required');
      state.currentAppId = current.id;
      if (!run.background) state.view = stop.final ? 'review' : 'dashboard';
      assertApplicationRun(current, runToken);
      await persist({ applicationIds: [current.id] });
    }

    /** Sets the checkpoint for a page the run may not continue from and audits a stop that reached human review. */
    function applyStopCheckpoint(application, signal, finalLabel) {
      const stop = stopCheckpoint(application, signal, finalLabel);
      setCheckpoint(application, stop.kind, stop.label, stop.status);
      if (stop.final) recordAudit('review_reached', application, { checkpointKind: stop.kind, pageCount: pageNumber(application), toStatus: stop.status });
      return stop;
    }

    /** Stop rule: the playbook's automated page limit. */
    function stopAtPageLimit(run) {
      const { current } = run;
      const pageLimit = automatedPageLimit(current);
      if (pageNumber(current) < pageLimit) return null;
      current.runStopReason = `The assistant reached this playbook’s ${pageLimit}-page safety limit and stopped.`;
      current.error = current.runStopReason;
      setCheckpoint(current, 'navigation_unknown', 'Automation page limit reached', 'needs_attention');
      return saveStop(run, 'dashboard');
    }

    /** Stop rule: the continuation would leave from a page signature the run already completed. */
    function stopAtRepeatedPage(run) {
      const { current } = run;
      if (!current.visitedSignatures?.includes(current.navigationGate.pageSignature)) return null;
      current.runStopReason = 'The application returned to a page it already completed. The assistant stopped to avoid a navigation loop.';
      current.error = current.runStopReason;
      setCheckpoint(current, 'page_changed', 'Repeated application page detected', 'needs_attention');
      return saveStop(run, 'dashboard');
    }

    /** Advance, wait, archive, rescan: activates the approved control and returns the next page's scanned application. */
    async function advanceToNextPage(run, tab) {
      const { current, runToken } = run;
      const signature = current.navigationGate.pageSignature;
      const progressMessage = `Page ${pageNumber(current)} verified. Moving to the next page…`;
      if (run.background) setApplicationProgress(current, progressMessage);
      else setBusy(progressMessage);
      assertApplicationRun(current, runToken);
      const advanced = await sendToTab(tab, { type: 'NAVA_ADVANCE' }, { application: current, requireLease: true });
      assertApplicationRun(current, runToken);
      if (!advanced?.ok || !advanced.advanced) {
        throw new Error(advanced?.navigationGate?.reason || 'The approved continuation control was no longer available.');
      }
      recordAudit('safe_advance', current, { pageCount: pageNumber(current) });
      const nextTab = await waitForNextPage(current, signature, runToken);
      assertApplicationRun(current, runToken);
      current.visitedSignatures = [...(current.visitedSignatures || []), signature];
      archiveCurrentPage(current);
      assertApplicationRun(current, runToken);
      await persist({ applicationIds: [current.id] });
      const next = await scanTab(nextTab, { quiet: true, applicationId: current.id, runToken });
      next.autoRun = true;
      return next;
    }

    /** Fills and verifies one page without advancing, then shows review or the dashboard. */
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
        applyStopCheckpoint(application, signal, 'Human review required');
      }
      application.runStopReason = application.navigationGate?.reason || '';
      assertApplicationRun(application, runToken);
      state.view = application.status === 'ready_for_review' ? 'review' : 'dashboard';
      await persist({ applicationIds: [application.id] });
    }

    /** Resumes a paused application only after its saved location and the resume decision both pass. */
    async function resumeApplication(application, useCurrentTab = false, { runToken = null } = {}) {
      assertApplicationRun(application, runToken);
      setBusy('Verifying the saved application page before resuming…');
      const tab = await resumeTab(application, useCurrentTab);
      assertApplicationRun(application, runToken);
      const locationError = tab?.id ? savedLocationError(application, tab.url) : null;
      if (locationError) return rejectChangedLocation(application, locationError, runToken);
      assertApplicationRun(application, runToken);
      const decision = await resumeDecisionFor(application, tab, runToken);
      if (!decision.allowed) return rejectResume(application, decision);

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

    /** The tab to resume in: the active tab on request, else the application's own tab; null when it is gone. */
    async function resumeTab(application, useCurrentTab) {
      try {
        return useCurrentTab ? await getActiveTab() : previewMode
          ? { id: application.tabId || 7001, url: application.url }
          : await chrome.tabs.get(application.tabId);
      } catch {
        return null;
      }
    }

    /**
     * Saved-location verification: the error that blocks resuming at this URL, or null. A verified application
     * that never recorded an approved path is pinned to this one.
     */
    function savedLocationError(application, url) {
      try {
        assertApprovedApplicationLocation(application, url);
        const expectedLocationHash = application.resumePoint?.locationHash;
        if (expectedLocationHash && expectedLocationHash !== workQueueEngine.signatureHash(workQueueEngine.safeLocation(url))) {
          throw new Error('The open tab is not at the saved application location.');
        }
        const expectedCommandLocationHash = application.resumePoint?.commandLocationHash;
        if (expectedCommandLocationHash && expectedCommandLocationHash !== workQueueEngine.signatureHash(commandLocation(url))) {
          throw new Error('The application query or page state changed since it was paused.');
        }
        if (!application.allowedPathPrefixes?.length) {
          application.allowedOrigins = [urlOrigin(url)].filter(Boolean);
          application.allowedPathPrefixes = [urlPath(url)].filter(Boolean);
        }
        return null;
      } catch (error) {
        return error;
      }
    }

    async function rejectChangedLocation(application, error, runToken) {
      assertApplicationRun(application, runToken);
      application.error = error.message;
      setCheckpoint(application, 'page_changed', 'Application tab changed', 'paused');
      recordAudit('resume_rejected', application, { resumeOutcome: 'location_changed', checkpointKind: 'page_changed', toStatus: 'paused' });
      state.view = 'dashboard';
      await persist({ applicationIds: [application.id] });
      return application;
    }

    /** The resume decision: re-reads the page when fresh client data is loaded and asks the work queue whether it matches. */
    async function resumeDecisionFor(application, tab, runToken) {
      const response = await readSavedPage(application, tab);
      assertApplicationRun(application, runToken);
      return workQueueEngine.resumeDecision(application, response?.ok ? {
        url: response.page?.url || tab?.url,
        pageSignature: response.navigationGate?.pageSignature || '',
      } : null, {
        sourceAvailable: Boolean(state.participant),
        sourceStale: Boolean(state.participant?._connector?.stale),
      });
    }

    async function readSavedPage(application, tab) {
      if (!tab?.id || !state.participant || state.participant?._connector?.stale) return null;
      try {
        return await sendToTab(
          tab,
          { type: 'NAVA_SCAN', participant: scanAnalysis.participantForApplication(state.participant, application) },
          { application },
        );
      } catch {
        return null;
      }
    }

    async function rejectResume(application, decision) {
      application.error = decision.reason;
      setCheckpoint(application, decision.checkpointKind, decision.reason, decision.outcome === 'source_expired' ? 'source_expired' : 'paused');
      recordAudit('resume_rejected', application, { resumeOutcome: decision.outcome, checkpointKind: decision.checkpointKind, toStatus: application.status });
      state.view = 'dashboard';
      await persist({ applicationIds: [application.id] });
      return application;
    }

    /** Resumes after a person completed a CAPTCHA or one-time code on the same page; it never solves either. */
    async function resumeHumanCheckpoint(application, { runToken = null } = {}) {
      assertApplicationRun(application, runToken);
      setBusy('Checking the human verification and resuming the application…');
      const tab = previewMode
        ? { id: application.tabId || 7001, url: currentPageUrl(application) }
        : await chrome.tabs.get(application.tabId);
      assertApprovedApplicationLocation(application, tab.url);
      const expectedLocation = commandLocation(currentPageUrl(application));
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
      const pendingKind = pendingHumanCheck(rescanned.submitGate);
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

    async function goToApplication(application) {
      if (previewMode) return;
      const tab = await chrome.tabs.get(application.tabId);
      await chrome.tabs.update(application.tabId, { active: true });
      if (tab.windowId) await chrome.windows.update(tab.windowId, { focused: true });
    }

    return {
      runThroughApplication,
      fillApplication,
      resumeApplication,
      resumeHumanCheckpoint,
      goToApplication,
    };
  }

  const api = { create };

  root.NavaApplicationRunner = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
