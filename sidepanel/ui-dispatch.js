// UI dispatch: the handler contract the action tables share, the own-property click, submit and change tables built from each domain's action groups, and the listeners that run a handler under its UI generation.
(function installUiDispatch(root) {
  'use strict';

  // Click and submit handlers share one ending. By default the dispatcher re-checks the UI generation and renders.
  // A handler that starts a new UI generation returns { uiToken } so the check uses it. SKIP_FINAL_RENDER means the
  // handler has already rendered, or it changed inputs on the current screen that a render would wipe out.
  const SKIP_FINAL_RENDER = Object.freeze({ skipFinalRender: true });

  /** The contract every action table is written against: the one SKIP_FINAL_RENDER outcome, and screen-only handlers over `state`. */
  function handlerContract(state) {
    /** A handler for buttons whose only effect is switching to another screen. */
    function showScreen(view) {
      return () => {
        state.view = view;
      };
    }

    return { SKIP_FINAL_RENDER, showScreen };
  }

  /**
   * deps:
   * - state, appRoot: panel state and the screen root that receives submit and change events.
   * - render(), assertUiGeneration(token), currentUiGeneration(): the screen and the UI-generation guard, read at event time.
   * - agentActions, recertificationActions, intakeActions, connectorActions, applicationActions: each action module's
   *   click, submit and change groups. Tables take them in that order.
   */
  function create(deps) {
    const {
      state,
      appRoot,
      render,
      assertUiGeneration,
      currentUiGeneration,
      agentActions,
      recertificationActions,
      intakeActions,
      connectorActions,
      applicationActions,
    } = deps;
    const { AGENT_CLICK_ACTIONS, AGENT_SUBMIT_ACTIONS, AGENT_CHANGE_HANDLERS } = agentActions;
    const { RECERTIFICATION_CLICK_ACTIONS, RECERTIFICATION_SUBMIT_ACTIONS } = recertificationActions;
    const { INTAKE_CLICK_ACTIONS, INTAKE_SUBMIT_ACTIONS } = intakeActions;
    const { CONNECTOR_CLICK_ACTIONS, CONNECTOR_SUBMIT_ACTIONS, CONNECTOR_CHANGE_HANDLERS } = connectorActions;
    const { APPLICATION_CLICK_ACTIONS, APPLICATION_SUBMIT_ACTIONS } = applicationActions;

    async function onClick(button, initialUiGeneration = currentUiGeneration()) {
      const action = button.dataset.action;
      state.error = '';
      await runUiHandler(CLICK_ACTIONS, action, { action, button, uiToken: initialUiGeneration });
    }

    async function onSubmit(form, uiToken = currentUiGeneration()) {
      assertUiGeneration(uiToken);
      state.error = '';
      await runUiHandler(SUBMIT_ACTIONS, form.id, { form, uiToken });
    }

    async function runUiHandler(handlers, key, context) {
      const handler = handlers.get(key);
      const outcome = handler ? await handler(context) : undefined;
      if (outcome === SKIP_FINAL_RENDER) return;
      assertUiGeneration(outcome?.uiToken ?? context.uiToken);
      render();
    }

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
    const CHANGE_HANDLERS = new Map([
      ...AGENT_CHANGE_HANDLERS,
      ...CONNECTOR_CHANGE_HANDLERS,
    ]);

    /** Installs the panel's click, submit and change listeners; the composition root calls it once, after every table exists. */
    function installListeners() {
      document.addEventListener('click', (event) => {
        const button = event.target.closest('[data-action]');
        if (!button) return;
        const uiToken = currentUiGeneration();
        onClick(button, uiToken).catch((error) => {
          if (error?.name === 'UiCancelledError' || uiToken !== currentUiGeneration()) return;
          state.error = error.message;
          render();
        });
      });

      appRoot.addEventListener('submit', (event) => {
        event.preventDefault();
        const uiToken = currentUiGeneration();
        onSubmit(event.target, uiToken).catch((error) => {
          if (error?.name === 'UiCancelledError' || uiToken !== currentUiGeneration()) return;
          state.error = error.message;
          render();
        });
      });

      appRoot.addEventListener('change', (event) => {
        const handler = CHANGE_HANDLERS.get(event.target.id);
        if (handler) handler(event);
      });
    }

    return {
      onClick,
      onSubmit,
      CLICK_ACTIONS,
      SUBMIT_ACTIONS,
      CHANGE_HANDLERS,
      installListeners,
    };
  }

  const api = { create, handlerContract };

  root.NavaUiDispatch = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
