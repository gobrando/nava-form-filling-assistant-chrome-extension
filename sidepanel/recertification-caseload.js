// Recertification caseload: the renewal cases from the data source, this session's follow-up answers for them (session storage only), and preparing an authorized case as an automatic application run.
(function installRecertificationCaseload(root) {
  'use strict';

  const RECERTIFICATION_WORKSPACE_KEY = 'nava:recertification-workspace';

  /**
   * deps:
   * - state, previewMode: panel state (recertifications, recertificationWorkspace, participant, apps) and the preview flag.
   * - recertificationEngine: NavaRecertificationEngine, which normalizes the caseload and merges saved answers.
   * - sendRuntime(message), setBusy(message), render(): the service-worker transport and the screen.
   * - assertUiGeneration(token), currentUiGeneration(): the UI-generation guard, read at call time.
   * - commitParticipant(participant), persist(options): coordinator writes for the prepared client.
   * - prepareAgentRuntime(), openSelectedPrograms(values), enqueueApplicationBatch(ids): planner start-up and automatic runs.
   */
  function create(deps) {
    const {
      state,
      previewMode,
      recertificationEngine,
      sendRuntime,
      setBusy,
      render,
      assertUiGeneration,
      currentUiGeneration,
      commitParticipant,
      persist,
      prepareAgentRuntime,
      openSelectedPrograms,
      enqueueApplicationBatch,
    } = deps;

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

    async function loadRecertifications(uiToken = currentUiGeneration()) {
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

    return {
      recertificationById,
      saveRecertificationWorkspace,
      loadRecertifications,
      prepareRecertification,
    };
  }

  const api = { create };

  root.NavaRecertificationCaseload = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
