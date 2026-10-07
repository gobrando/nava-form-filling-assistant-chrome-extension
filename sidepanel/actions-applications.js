// Application actions: the side-panel handlers for the dashboard and each application card — runs under a UI-bound lease, scans, pauses, handoffs — and for the questions and handoff forms.
(function installApplicationActions(root) {
  'use strict';

  /**
   * deps:
   * - state, previewMode, render(), getActiveTab(), decoded(value): panel state, the screen, the active tab, the data-attribute decoder.
   * - SKIP_FINAL_RENDER, showScreen(view): the dispatcher handler contract (NavaUiDispatch.handlerContract).
   * - assertUiGeneration(token), withNewApplicationRun(application, action, options): run control.
   * - withApplicationLease, revokeApplicationRun, persist, exportAuditLog: coordinator writes.
   * - checkpoint(kind, label), setCheckpoint(application, kind, label, status), recordAudit(type, application, details): queue state.
   * - scanTab, runThroughApplication, fillApplication, goToApplication, resumeApplication, resumeHumanCheckpoint: the write path.
   */
  function create(deps) {
    const {
      state,
      previewMode,
      render,
      getActiveTab,
      decoded,
      SKIP_FINAL_RENDER,
      showScreen,
      assertUiGeneration,
      withNewApplicationRun,
      withApplicationLease,
      revokeApplicationRun,
      persist,
      exportAuditLog,
      checkpoint,
      setCheckpoint,
      recordAudit,
      scanTab,
      runThroughApplication,
      fillApplication,
      goToApplication,
      resumeApplication,
      resumeHumanCheckpoint,
    } = deps;

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

    return {
      answersFromQuestionsForm,
      APPLICATION_CLICK_ACTIONS,
      APPLICATION_SUBMIT_ACTIONS,
    };
  }

  const api = { create };

  root.NavaApplicationActions = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
