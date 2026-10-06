// Recertification actions: the side-panel handlers for the renewal caseload — opening it, reviewing a case, recording outreach and intake answers, and preparing an authorized case.
(function installRecertificationActions(root) {
  'use strict';

  /**
   * deps:
   * - state, render(), decoded(value): panel state, the screen, and the data-attribute decoder.
   * - SKIP_FINAL_RENDER, showScreen(view): the dispatcher handler contract (NavaUiDispatch.handlerContract).
   * - recertificationEngine: NavaRecertificationEngine, which re-normalizes a case after its intake answers change.
   * - recertificationById(id), loadRecertifications(uiToken), saveRecertificationWorkspace(item), prepareRecertification(item, uiToken):
   *   the recertification caseload.
   */
  function create(deps) {
    const {
      state,
      render,
      decoded,
      SKIP_FINAL_RENDER,
      showScreen,
      recertificationEngine,
      recertificationById,
      loadRecertifications,
      saveRecertificationWorkspace,
      prepareRecertification,
    } = deps;

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

    return {
      RECERTIFICATION_CLICK_ACTIONS,
      RECERTIFICATION_SUBMIT_ACTIONS,
    };
  }

  const api = { create };

  root.NavaRecertificationActions = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
