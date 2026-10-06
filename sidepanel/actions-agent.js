// Agent actions: the side-panel handlers for the planner runtime — the shared planner gateway, client links, enabling the agent, and the model-provider form and select.
(function installAgentActions(root) {
  'use strict';

  /**
   * deps:
   * - state, render(), assertUiGeneration(token): panel state, the screen, and the UI-generation guard.
   * - SKIP_FINAL_RENDER: the dispatcher outcome for handlers that render for themselves (NavaUiDispatch.handlerContract).
   * - prepareAgentRuntime(), saveAgentProvider(form, uiToken), mintClientLink(application): the planner runtime.
   * - enqueueApplicationBatch(ids): restarts automatic runs the missing planner interrupted.
   */
  function create(deps) {
    const {
      state,
      render,
      assertUiGeneration,
      SKIP_FINAL_RENDER,
      prepareAgentRuntime,
      saveAgentProvider,
      mintClientLink,
      enqueueApplicationBatch,
    } = deps;

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

    /** The model-provider select shows the companion endpoint and token fields only for a subscription CLI. */
    function showModelCompanionFields(event) {
      const fields = document.getElementById('model-companion-fields');
      if (fields) fields.hidden = event.target.value === 'chrome-local';
    }

    const AGENT_CLICK_ACTIONS = [
      ['save-planner', savePlannerGateway],
      ['client-link', createClientLink],
      ['enable-agent', enableAgent],
    ];
    const AGENT_SUBMIT_ACTIONS = [
      ['model-provider-form', submitModelProvider],
    ];
    const AGENT_CHANGE_HANDLERS = [
      ['model-provider', showModelCompanionFields],
    ];

    return {
      AGENT_CLICK_ACTIONS,
      AGENT_SUBMIT_ACTIONS,
      AGENT_CHANGE_HANDLERS,
    };
  }

  const api = { create };

  root.NavaAgentActions = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
