// Connector actions: the side-panel handlers for the data-source connector — provider choice, settings, field mapping, reset, confirming a retrieved record — and reconciling the coordinator after a connector change.
(function installConnectorActions(root) {
  'use strict';

  /**
   * deps:
   * - state, previewMode, setBusy(message), sendRuntime(message), getActiveTab(): panel state, transport and the active tab.
   * - SKIP_FINAL_RENDER, showScreen(view): the dispatcher handler contract (NavaUiDispatch.handlerContract).
   * - connectorEngine, managedConnector(): provider definitions and canonical fields, and whether a managed connector is saved.
   * - assertUiGeneration(token), currentUiGeneration(), cancelAllRuns(): run control.
   * - withCoordinatorMutation, applyCoordinatorMetadata, scheduleCoordinatorSync, restore: coordinator sync.
   * - commitParticipant(participant), persist(options): coordinator writes for a confirmed connector record.
   * - canonicalHomeView(), setCheckpoint(application, kind, label, status): the home screen and queue checkpoints.
   */
  function create(deps) {
    const {
      state,
      previewMode,
      setBusy,
      sendRuntime,
      getActiveTab,
      SKIP_FINAL_RENDER,
      showScreen,
      connectorEngine,
      managedConnector,
      assertUiGeneration,
      currentUiGeneration,
      cancelAllRuns,
      withCoordinatorMutation,
      applyCoordinatorMetadata,
      scheduleCoordinatorSync,
      restore,
      commitParticipant,
      persist,
      canonicalHomeView,
      setCheckpoint,
    } = deps;

    async function restoreConnector() {
      const response = await sendRuntime({ type: 'GET_CONNECTOR_STATUS' });
      if (!response?.ok) throw new Error(response?.error || 'The data-source status could not be loaded.');
      state.connector = response.connector;
    }

    async function reconcileConnectorMutation(response, uiToken, nextView) {
      if (!response?.ok) {
        if (response?.stale) scheduleCoordinatorSync();
        throw new Error(response?.error || 'The data-source change could not be saved.');
      }
      const previewInvalidation = previewMode && Boolean(state.participant?._connector);
      const returnedEpoch = Number(response.sessionEpoch);
      const coordinatorChanged = !previewMode
        && Number.isSafeInteger(returnedEpoch)
        && returnedEpoch > 0
        && returnedEpoch !== Number(state.sessionEpoch);
      if (response.assistantInvalidated || coordinatorChanged) {
        cancelAllRuns();
        await restore({ preserveView: true });
      } else if (previewInvalidation) {
        cancelAllRuns();
        state.participant = null;
        state.currentAppId = null;
        state.apps.forEach((application) => {
          application.error = 'The connected data source or field mapping changed. Reload the client before resuming.';
          setCheckpoint(application, 'source_expired', 'Reload client data after connector change', 'source_expired');
        });
      } else {
        applyCoordinatorMetadata(response);
      }
      state.connector = response.connector;
      state.connectorDraft = null;
      state.connectorSchema = [];
      state.pendingConnectorRecord = null;
      if (uiToken === currentUiGeneration()) state.view = nextView || canonicalHomeView();
    }

    function configureConnector() {
      state.connectorDraft = null;
      state.connectorSchema = [];
      state.pendingConnectorRecord = null;
      state.view = managedConnector() ? 'connector' : 'providers';
    }

    function selectConnectorProvider({ button }) {
      const provider = connectorEngine.providerDefinition(button.dataset.provider);
      if (!provider) throw new Error('Choose a supported data source.');
      state.connectorDraft = {
        provider: provider.id,
        organizationName: '',
        backendUrl: '',
        connectionId: '',
        sourceId: '',
        maxAgeDays: 30,
        mappings: {},
      };
      state.connectorSchema = [];
      state.view = 'connector';
    }

    /** Fills the connector form with the local mock connector's settings; the caseworker still reviews and submits it. */
    function fillLocalConnectorSettings() {
      const providerSelect = document.getElementById('connector-provider');
      providerSelect.value = 'apricot360';
      providerSelect.dispatchEvent(new Event('change', { bubbles: true }));
      document.getElementById('connector-org').value = 'Riverside Community Services';
      document.getElementById('connector-url').value = 'http://127.0.0.1:4789';
      document.getElementById('connection-id').value = 'nava-demo';
      document.getElementById('connector-source-id').value = '99';
      return SKIP_FINAL_RENDER;
    }

    async function resetConnector({ uiToken }) {
      setBusy('Disconnecting the data source…');
      await withCoordinatorMutation(async () => {
        const response = await sendRuntime({ type: 'RESET_CONNECTOR', sessionEpoch: state.sessionEpoch });
        await reconcileConnectorMutation(response, uiToken, 'choice');
      });
    }

    function backToRecordId() {
      state.pendingConnectorRecord = null;
      state.view = 'record';
    }

    async function confirmConnectorRecord({ uiToken }) {
      if (!state.pendingConnectorRecord) throw new Error('Retrieve and review a connector record first.');
      const participant = state.pendingConnectorRecord;
      const activeTab = await getActiveTab();
      assertUiGeneration(uiToken);
      await commitParticipant(participant);
      assertUiGeneration(uiToken);
      state.pendingConnectorRecord = null;
      state.activeTab = activeTab;
      state.view = 'programs';
      await persist();
    }

    /** The submitted connector settings. Resubmitting the saved source keeps its reviewed mappings under the next mapping version. */
    function connectorConfigFromForm(data) {
      const submittedIdentity = {
        provider: String(data.get('provider') || '').trim(),
        backendUrl: String(data.get('backendUrl') || '').trim(),
        connectionId: String(data.get('connectionId') || '').trim(),
        sourceId: String(data.get('sourceId') || '').trim(),
      };
      const sameMappedSource = managedConnector()
        && ['provider', 'backendUrl', 'connectionId', 'sourceId']
          .every((key) => String(state.connector[key] || '').trim() === submittedIdentity[key]);
      return {
        ...submittedIdentity,
        organizationName: String(data.get('organizationName') || '').trim(),
        maxAgeDays: Number(data.get('maxAgeDays')),
        mappings: sameMappedSource ? state.connector.mappings : {},
        mappingVersion: sameMappedSource ? Number(state.connector.mappingVersion || 1) + 1 : 1,
      };
    }

    async function submitConnectorSettings({ form, uiToken }) {
      const config = connectorConfigFromForm(new FormData(form));
      setBusy('Testing the connector and loading labeled fields…');
      const response = await sendRuntime({ type: 'DISCOVER_CONNECTOR', config });
      assertUiGeneration(uiToken);
      if (!response?.ok) throw new Error(response?.error || 'The connector could not be verified.');
      state.connectorDraft = { ...response.config, mappings: response.suggestions || {} };
      state.connectorSchema = response.schema || [];
      state.view = 'connector-mapping';
    }

    async function submitConnectorMapping({ form, uiToken }) {
      const data = new FormData(form);
      const mappings = {};
      connectorEngine.CANONICAL_FIELDS.forEach((field) => {
        const source = String(data.get(`map-${field.key}`) || '').trim();
        if (source) mappings[field.key] = source;
      });
      const config = { ...state.connectorDraft, mappings };
      setBusy('Saving the reviewed field mapping…');
      await withCoordinatorMutation(async () => {
        const response = await sendRuntime({
          type: 'SAVE_CONNECTOR',
          sessionEpoch: state.sessionEpoch,
          config,
          schema: state.connectorSchema,
        });
        await reconcileConnectorMutation(response, uiToken);
      });
    }

    /** The connector-provider select relabels the source-id field with the chosen provider's own term. */
    function relabelConnectorSource(event) {
      const provider = connectorEngine.providerDefinition(event.target.value);
      if (!provider) return;
      const sourceLabel = document.querySelector('label[for="connector-source-id"]');
      const sourceInput = document.getElementById('connector-source-id');
      if (sourceLabel) sourceLabel.textContent = provider.sourceLabel;
      if (sourceInput) sourceInput.placeholder = provider.sourceLabel;
    }

    const CONNECTOR_CLICK_ACTIONS = [
      ['configure-connector', configureConnector],
      ['back-providers', showScreen('providers')],
      ['select-provider', selectConnectorProvider],
      ['back-connector', showScreen('connector')],
      ['local-connector-settings', fillLocalConnectorSettings],
      ['reset-connector', resetConnector],
      ['back-record-id', backToRecordId],
      ['confirm-connector-record', confirmConnectorRecord],
    ];
    const CONNECTOR_SUBMIT_ACTIONS = [
      ['connector-form', submitConnectorSettings],
      ['connector-mapping-form', submitConnectorMapping],
    ];
    const CONNECTOR_CHANGE_HANDLERS = [
      ['connector-provider', relabelConnectorSource],
    ];

    return {
      restoreConnector,
      connectorConfigFromForm,
      CONNECTOR_CLICK_ACTIONS,
      CONNECTOR_SUBMIT_ACTIONS,
      CONNECTOR_CHANGE_HANDLERS,
    };
  }

  const api = { create };

  root.NavaConnectorActions = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
