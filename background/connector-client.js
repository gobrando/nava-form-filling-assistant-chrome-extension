// Service-worker connector client: read-only requests to the managed connector service, the bundled fictional demo connector when none is configured, program tabs, and the connector-change rule that expires connector-derived client data.
(function installConnectorClient(root) {
  'use strict';

  /**
   * deps:
   * - rules: the coordinator rules (background/coordinator-rules.js).
   * - connectorEngine, programCatalog, recertificationEngine: the shared engines.
   * - demoConnectorData: the fictional demo data (shared/demo-connector-data.js).
   * - storageKeys: CONNECTOR_STORAGE_KEY, SESSION_STORAGE_KEY, QUEUE_STORAGE_KEY, COORDINATOR_STORAGE_KEY.
   * - coordinatorState, revokeApplications: the coordinator core.
   * - respondCoordinated(operation, sendResponse, errorExtras): runs one operation on the coordinator chain.
   */
  function create(deps) {
    const {
      rules,
      connectorEngine,
      programCatalog,
      recertificationEngine,
      demoConnectorData,
      storageKeys,
      coordinatorState,
      revokeApplications,
      respondCoordinated,
    } = deps;
    const { CONNECTOR_STORAGE_KEY, SESSION_STORAGE_KEY, QUEUE_STORAGE_KEY, COORDINATOR_STORAGE_KEY } = storageKeys;
    const { coordinatorFields, storedApplicationIds, assertCoordinatorEpoch } = rules;

    function demoConnectorStatus() {
      return {
        mode: 'demo',
        provider: 'bundled-demo-records',
        organizationName: 'Nava fictional test data',
        status: 'ready',
        message: 'Using bundled fictional records. Configure a managed connector to retrieve organization data.',
      };
    }

    // The shared fictional caseload under 'demo-recert' ids, due dates computed from `now` on every call.
    function demoRecertifications(now = new Date()) {
      const cases = demoConnectorData.RECERTIFICATION_CASELOAD.map((entry) => ({
        ...demoConnectorData.recertificationCase(entry, 'demo-recert', now),
        source: 'fictional-demo',
      }));
      return recertificationEngine.normalizeCaseload(cases, { today: now });
    }

    function demoRecordLookup(recordId) {
      const record = demoConnectorData.CLIENT_RECORDS.find((item) => item.record_id === recordId) || null;
      return {
        ok: Boolean(record),
        record,
        provider: 'bundled-demo-records',
        connector: { organizationName: 'Nava fictional test data', stale: false },
        message: record
          ? 'Fictional demo record loaded.'
          : 'No fictional record matched. Configure a managed data source or paste client JSON.',
      };
    }

    function demoRecertificationCaseload() {
      return {
        ok: true,
        cases: demoRecertifications(),
        source: 'fictional-demo',
        connector: { organizationName: 'Nava fictional test data' },
        message: 'Fictional recertification caseload loaded.',
      };
    }

    async function storedConnector() {
      const saved = await chrome.storage.local.get(CONNECTOR_STORAGE_KEY);
      return saved[CONNECTOR_STORAGE_KEY] || null;
    }

    function connectorUrl(config, resource, query = {}) {
      const url = new URL(`${config.backendUrl}/v1/connectors/${encodeURIComponent(config.connectionId)}/${resource}`);
      Object.entries(query).forEach(([key, value]) => url.searchParams.set(key, String(value)));
      return url.toString();
    }

    function connectorSourceQuery(config) {
      const sourceId = config.sourceId ?? config.formId;
      return {
        sourceId,
        ...(config.provider === 'apricot360' && config.formId ? { formId: config.formId } : {}),
      };
    }

    async function connectorRequest(configInput, resource, query = {}) {
      const config = connectorEngine.sanitizeConfig(configInput);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 12000);
      try {
        const response = await fetch(connectorUrl(config, resource, query), {
          method: 'GET',
          credentials: 'include',
          headers: { Accept: 'application/json' },
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(`Connector service returned ${response.status}.`);
        const payload = await response.json();
        if (payload?.ok === false) throw new Error(payload.error || 'The connector service rejected the request.');
        return payload;
      } catch (error) {
        if (error?.name === 'AbortError') throw new Error('The connector service did not respond within 12 seconds.');
        throw error;
      } finally {
        clearTimeout(timeout);
      }
    }

    async function discoverConnector(configInput) {
      const config = connectorEngine.sanitizeConfig(configInput);
      const health = await connectorRequest(config, 'health');
      if (health.provider && health.provider !== config.provider) {
        const expected = connectorEngine.providerDefinition(config.provider)?.name || config.provider;
        const actual = connectorEngine.providerDefinition(health.provider)?.name || health.provider;
        throw new Error(`This connection reports ${actual}, not ${expected}.`);
      }
      const authoritativeConfig = {
        ...config,
        organizationName: String(health.organizationName || config.organizationName).trim(),
      };
      const schemaPayload = await connectorRequest(authoritativeConfig, 'schema', connectorSourceQuery(authoritativeConfig));
      const schema = connectorEngine.normalizeSchemaFields(schemaPayload);
      if (!schema.length) throw new Error('The connector returned no labeled fields for that form.');
      return {
        ok: true,
        health: {
          organizationName: health.organizationName || config.organizationName,
          provider: health.provider || config.provider,
        },
        config: authoritativeConfig,
        schema,
        suggestions: connectorEngine.suggestMappings(schema, authoritativeConfig.mappings),
      };
    }

    async function lookupManagedRecord(recordId, saved) {
      const payload = await connectorRequest(saved.config, `records/${encodeURIComponent(recordId)}`, connectorSourceQuery(saved.config));
      const mapped = connectorEngine.mapRecord(payload, saved.config, saved.schema);
      return {
        ok: mapped.found,
        record: mapped.record,
        provider: saved.config.provider,
        connector: {
          organizationName: saved.config.organizationName,
          retrievedAt: mapped.record?._connector?.retrievedAt,
          stale: Boolean(mapped.stale),
          freshness: mapped.freshness,
          mappedFields: Object.keys(mapped.provenance || {}).length,
        },
        message: mapped.found
          ? mapped.freshness === 'unknown'
            ? 'Record loaded, but the connector did not provide a valid source-modified time.'
            : mapped.stale
              ? `Record loaded, but the source was last updated more than ${saved.config.maxAgeDays} days ago.`
            : 'Record loaded from the managed connector.'
          : 'The connector returned no mapped values for that record ID.',
      };
    }

    async function listManagedRecertifications(saved) {
      const payload = await connectorRequest(saved.config, 'recertifications', connectorSourceQuery(saved.config));
      const cases = recertificationEngine.normalizeCaseload(payload?.cases || payload?.items || []);
      return {
        ok: true,
        cases,
        source: 'managed-connector',
        connector: { organizationName: saved.config.organizationName },
        message: cases.length
          ? `${cases.length} recertification record${cases.length === 1 ? '' : 's'} loaded.`
          : 'The connector returned no upcoming recertifications.',
      };
    }

    function savedConnectorStatus(saved) {
      return { ...saved.config, status: 'ready', connectedAt: saved.connectedAt, schemaFieldCount: saved.schema.length };
    }

    async function connectorStatus() {
      const saved = await storedConnector();
      return { ok: true, connector: saved ? savedConnectorStatus(saved) : demoConnectorStatus() };
    }

    async function lookupRecord(recordId) {
      const saved = await storedConnector();
      return saved ? lookupManagedRecord(recordId, saved) : demoRecordLookup(recordId);
    }

    async function recertificationCaseload() {
      const saved = await storedConnector();
      return saved ? listManagedRecertifications(saved) : demoRecertificationCaseload();
    }

    // Opens one background tab per planned workflow; an invalid program list throws before any tab opens.
    function openProgramTabs(programs) {
      const keys = Array.isArray(programs) ? programs : [];
      return Promise.all(
        programCatalog.planWorkflows(keys)
          .map(async (workflow) => {
            const tab = await chrome.tabs.create({ url: workflow.url, active: false });
            return { ...workflow, tabId: tab.id };
          }),
      );
    }

    // A connector change makes connector-derived client data untrustworthy: expire its runs and release the claim.
    async function invalidateConnectorParticipant() {
      const [sessionResult, queueResult] = await Promise.all([
        chrome.storage.session.get(SESSION_STORAGE_KEY),
        chrome.storage.local.get(QUEUE_STORAGE_KEY),
      ]);
      const session = sessionResult[SESSION_STORAGE_KEY] || {};
      if (!session.participant?._connector) return { invalidated: false, coordinator: await coordinatorState() };
      const ids = storedApplicationIds(session.apps, queueResult[QUEUE_STORAGE_KEY]?.applications);
      const result = await revokeApplications({
        applicationIds: ids,
        status: 'source_expired',
        checkpointKind: 'source_expired',
        checkpointLabel: 'Reload client data after connector change',
      });
      result.session.participant = null;
      result.session.currentAppId = null;
      result.coordinator.sessionEpoch += 1;
      result.coordinator.participantSessionId = '';
      result.coordinator.stateRevision += 1;
      result.coordinator.updatedAt = new Date().toISOString();
      await Promise.all([
        chrome.storage.session.set({ [SESSION_STORAGE_KEY]: result.session }),
        chrome.storage.local.set({ [COORDINATOR_STORAGE_KEY]: result.coordinator }),
      ]);
      return { invalidated: true, coordinator: result.coordinator };
    }

    function connectorChangeResponse(connector, invalidation) {
      return {
        ok: true,
        connector,
        assistantInvalidated: invalidation.invalidated,
        ...coordinatorFields(invalidation.coordinator),
      };
    }

    async function saveConnector(message) {
      const coordinator = await coordinatorState();
      assertCoordinatorEpoch(message, coordinator);
      const schema = connectorEngine.normalizeSchemaFields(message.schema);
      const config = connectorEngine.validateMappings(message.config, schema);
      const saved = { config, schema, connectedAt: new Date().toISOString() };
      const invalidation = await invalidateConnectorParticipant();
      await chrome.storage.local.set({ [CONNECTOR_STORAGE_KEY]: saved });
      return connectorChangeResponse(savedConnectorStatus(saved), invalidation);
    }

    async function resetConnector(message) {
      const coordinator = await coordinatorState();
      assertCoordinatorEpoch(message, coordinator);
      const invalidation = await invalidateConnectorParticipant();
      await chrome.storage.local.remove(CONNECTOR_STORAGE_KEY);
      return connectorChangeResponse(demoConnectorStatus(), invalidation);
    }

    // Answers a connector request asynchronously; failures carry the request's empty result fields and the error text.
    function respondWith(pending, sendResponse, emptyResult = {}) {
      pending
        .then(sendResponse)
        .catch((error) => sendResponse({ ok: false, ...emptyResult, error: error.message }));
      return true;
    }

    function handleGetConnectorStatus(_message, _sender, sendResponse) {
      return respondWith(connectorStatus(), sendResponse);
    }

    function handleDiscoverConnector(message, _sender, sendResponse) {
      return respondWith(discoverConnector(message.config), sendResponse);
    }

    function handleSaveConnector(message, _sender, sendResponse) {
      return respondCoordinated(() => saveConnector(message), sendResponse);
    }

    function handleResetConnector(message, _sender, sendResponse) {
      return respondCoordinated(() => resetConnector(message), sendResponse);
    }

    function handleLookupRecord(message, _sender, sendResponse) {
      const recordId = String(message.recordId || '').trim();
      if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,119}$/.test(recordId)) {
        sendResponse({ ok: false, record: null, message: 'Enter a valid client record ID.' });
        return false;
      }
      return respondWith(lookupRecord(recordId), sendResponse, { record: null });
    }

    function handleListRecertifications(_message, _sender, sendResponse) {
      return respondWith(recertificationCaseload(), sendResponse, { cases: [] });
    }

    function handleOpenPrograms(message, _sender, sendResponse) {
      return respondWith(openProgramTabs(message.programs).then((opened) => ({ ok: true, opened })), sendResponse);
    }

    // Returns the handler's answer to Chrome (true = response pending), or undefined for a type this router does not own.
    function routeConnectorMessage(message, sender, sendResponse) {
      if (message?.type === 'GET_CONNECTOR_STATUS') return handleGetConnectorStatus(message, sender, sendResponse);
      if (message?.type === 'DISCOVER_CONNECTOR') return handleDiscoverConnector(message, sender, sendResponse);
      if (message?.type === 'SAVE_CONNECTOR') return handleSaveConnector(message, sender, sendResponse);
      if (message?.type === 'RESET_CONNECTOR') return handleResetConnector(message, sender, sendResponse);
      if (message?.type === 'LOOKUP_RECORD') return handleLookupRecord(message, sender, sendResponse);
      if (message?.type === 'LIST_RECERTIFICATIONS') return handleListRecertifications(message, sender, sendResponse);
      if (message?.type === 'OPEN_PROGRAMS') return handleOpenPrograms(message, sender, sendResponse);
      return undefined;
    }
    return { routeConnectorMessage };
  }

  const api = { create };

  root.NavaConnectorClient = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
