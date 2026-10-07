// Data-source screens: the connector status chip, provider catalog, connection setup, field mapping, and imported-record review.
(function installConnectorViews(root) {
  'use strict';

  /**
   * deps:
   * - state, appRoot, previewMode: panel state, the screen root, and simulated-preview flag.
   * - format: NavaPanelFormat helpers; connectorEngine: provider catalog and canonical fields.
   * - renderError(), managedConnector(): shared panel helpers.
   * - renderRecordId(): the record-ID screen shown when no imported record is pending.
   */
  function create(deps) {
    const {
      state,
      appRoot,
      previewMode,
      format,
      connectorEngine,
      renderError,
      managedConnector,
      renderRecordId,
    } = deps;
    const { escapeHtml, displayValue, formatTimestamp, providerInitials } = format;

    function connectorTitle() {
      return managedConnector() ? state.connector.organizationName : 'Nava fictional test data';
    }

    function connectorProvider(config = state.connector) {
      return connectorEngine.providerDefinition(config?.provider) || connectorEngine.providerDefinition('apricot360');
    }

    function connectorSourceId(config = state.connector) {
      return String(config?.sourceId ?? config?.formId ?? '');
    }

    function renderConnectorStatus() {
      const managed = managedConnector();
      const mapped = Object.keys(state.connector?.mappings || {}).length;
      return `
      <button class="connector-status ${managed ? 'connected' : ''}" type="button" data-action="configure-connector">
        <span class="connector-status-icon" aria-hidden="true">${managed ? '✓' : 'DB'}</span>
        <span><strong>${managed ? escapeHtml(connectorTitle()) : 'Connect an organization database'}</strong><small>${managed ? `${escapeHtml(connectorProvider().name)} · ${mapped} mapped fields · read-only` : 'Browse Apricot, Salesforce, HMIS, and other catalog sources'}</small></span>
        <span class="connector-status-action">${managed ? 'Manage' : 'Choose'} <span aria-hidden="true">›</span></span>
      </button>`;
    }

    function renderProviderCatalog() {
      appRoot.innerHTML = `
      <section>
        <button class="back-button" type="button" data-action="home"><span aria-hidden="true">←</span> Home</button>
        <div class="intro">
          <p class="eyebrow">Data source</p>
          <h1>Choose your database</h1>
          <p class="lede">Select the system your organization uses. The extension connects only through a Nava-managed, read-only service; provider credentials never enter Chrome.</p>
        </div>
        ${renderError()}
        <div class="provider-grid">
          ${connectorEngine.PROVIDER_CATALOG.map((provider) => {
            const available = provider.readiness === 'demo-tested';
            return `
            <button class="provider-card" type="button" data-action="select-provider" data-provider="${escapeHtml(provider.id)}" aria-describedby="provider-readiness-${escapeHtml(provider.id)}">
              <span class="provider-icon" aria-hidden="true">${escapeHtml(providerInitials(provider.name))}</span>
              <span class="provider-copy"><strong>${escapeHtml(provider.name)}</strong><small>${escapeHtml(provider.category)}</small></span>
              <span id="provider-readiness-${escapeHtml(provider.id)}" class="readiness-chip ${available ? 'demo-tested' : 'adapter-required'}">${available ? 'Fictional demo available' : 'Provisioned Nava adapter required'}</span>
              <span class="chevron" aria-hidden="true">›</span>
            </button>`;
          }).join('')}
        </div>
        <div class="notice warning" style="margin-top:18px"><span aria-hidden="true">!</span><span>Only the fictional Apricot-shaped adapter runs in this repository. The other providers require an authorized Nava connector service before real records can be retrieved.</span></div>
      </section>`;
    }

    function connectorDraft() {
      if (state.connectorDraft) return state.connectorDraft;
      if (managedConnector()) return { ...state.connector, mappings: { ...(state.connector.mappings || {}) } };
      return {
        provider: 'apricot360',
        organizationName: '',
        backendUrl: '',
        connectionId: '',
        sourceId: '',
        maxAgeDays: 30,
        mappings: {},
      };
    }

    function renderConnectorSetup() {
      const draft = connectorDraft();
      const provider = connectorProvider(draft);
      appRoot.innerHTML = `
      <section>
        <button class="back-button" type="button" data-action="back-providers"><span aria-hidden="true">←</span> Databases</button>
        <div class="intro">
          <p class="eyebrow">Data source</p>
          <h1>Connect a client data source</h1>
          <p class="lede">Choose a provider, connect through a Nava-managed service, and load labeled fields. Provider credentials remain on the service.</p>
        </div>
        ${renderError()}
        <div class="notice"><span aria-hidden="true">⌁</span><span>The extension accepts an opaque connection ID, never a provider secret, access token, password, or API key. Listed providers still require a Nava service adapter and organization authorization.</span></div>
        <form id="connector-form" class="stack connector-form">
          <div class="field">
            <label for="connector-provider">Database provider</label>
            <select id="connector-provider" name="provider" required>
              ${connectorEngine.PROVIDER_CATALOG.map((item) => `<option value="${escapeHtml(item.id)}" ${draft.provider === item.id ? 'selected' : ''}>${escapeHtml(item.name)} — ${item.readiness === 'demo-tested' ? 'fictional demo' : 'provisioned adapter required'}</option>`).join('')}
            </select>
            <p class="field-hint">Apricot has a tested fictional adapter. Every provider requires a separately deployed, authorized Nava connector before real records can be used.</p>
          </div>
          <div class="field">
            <label for="connector-org">Organization name</label>
            <input id="connector-org" name="organizationName" type="text" value="${escapeHtml(draft.organizationName)}" placeholder="Riverside Community Services" required>
          </div>
          <div class="field">
            <label for="connector-url">Nava connector service URL</label>
            <input id="connector-url" name="backendUrl" type="text" inputmode="url" value="${escapeHtml(draft.backendUrl)}" placeholder="https://connectors.example.org" required>
            <p class="field-hint">HTTPS is required, except for localhost development.</p>
          </div>
          <div class="field">
            <label for="connection-id">Connection ID</label>
            <input id="connection-id" name="connectionId" type="text" value="${escapeHtml(draft.connectionId)}" placeholder="riverside-apricot" autocomplete="off" required>
          </div>
          <div class="grid-fields">
            <div class="field">
              <label for="connector-source-id">Form / resource key</label>
              <input id="connector-source-id" name="sourceId" type="text" value="${escapeHtml(connectorSourceId(draft))}" placeholder="${escapeHtml(provider.sourceLabel)}" required>
            </div>
            <div class="field">
              <label for="connector-age">Stale after</label>
              <select id="connector-age" name="maxAgeDays">
                ${[1, 7, 30, 90].map((days) => `<option value="${days}" ${Number(draft.maxAgeDays) === days ? 'selected' : ''}>${days} day${days === 1 ? '' : 's'}</option>`).join('')}
              </select>
            </div>
          </div>
          <div class="form-actions">
            <button class="primary-button" type="submit">Test connection and load fields</button>
            ${previewMode ? '<button class="secondary-button" type="button" data-action="local-connector-settings">Use local demo settings</button>' : ''}
            ${managedConnector() ? '<button class="link-button danger-link" type="button" data-action="reset-connector">Disconnect and use demo data</button>' : ''}
          </div>
        </form>
      </section>`;
    }

    function renderConnectorMapping() {
      const draft = connectorDraft();
      const schema = connectorEngine.normalizeSchemaFields(state.connectorSchema);
      if (!schema.length) {
        state.view = 'connector';
        return renderConnectorSetup();
      }
      const categories = [...new Set(connectorEngine.CANONICAL_FIELDS.map((field) => field.category))];
      appRoot.innerHTML = `
      <section>
        <button class="back-button" type="button" data-action="back-connector"><span aria-hidden="true">←</span> Connection</button>
        <div class="intro">
          <p class="eyebrow">Schema mapping</p>
          <h1>Confirm what each field means</h1>
          <p class="lede">Suggestions use source labels and reference tags. Review every mapping—opaque or numeric source IDs never determine meaning.</p>
        </div>
        ${renderError()}
        <div class="connector-summary">
          <span class="connector-status-icon" aria-hidden="true">✓</span>
          <span><strong>${escapeHtml(draft.organizationName)}</strong><small>${escapeHtml(connectorProvider(draft).name)} · ${schema.length} labeled source fields loaded · source ${escapeHtml(connectorSourceId(draft))}</small></span>
        </div>
        <form id="connector-mapping-form">
          ${categories.map((category) => `
            <p class="section-label">${escapeHtml(category)}</p>
            <div class="mapping-list">
              ${connectorEngine.CANONICAL_FIELDS.filter((field) => field.category === category).map((canonical) => `
                <label class="mapping-row">
                  <span><strong>${escapeHtml(canonical.label)}</strong>${canonical.sensitive ? '<small>Sensitive · masked in review</small>' : '<small>Canonical destination</small>'}</span>
                  <select name="map-${escapeHtml(canonical.key)}" aria-label="Source field for ${escapeHtml(canonical.label)}">
                    <option value="">Not mapped</option>
                    ${schema.map((field) => `<option value="${escapeHtml(field.id)}" ${draft.mappings?.[canonical.key] === field.id ? 'selected' : ''}>${escapeHtml(field.label)} — ${escapeHtml(field.id)}</option>`).join('')}
                  </select>
                </label>`).join('')}
            </div>`).join('')}
          <div class="notice warning" style="margin-top:18px"><span aria-hidden="true">!</span><span>Saving authorizes read-only lookup through this reviewed mapping. It does not grant the extension permission to edit the source system.</span></div>
          <div class="form-actions">
            <button class="primary-button" type="submit">Save read-only connection</button>
          </div>
        </form>
      </section>`;
    }

    function renderConnectorRecordReview() {
      const record = state.pendingConnectorRecord;
      if (!record?._connector) {
        state.view = 'record';
        return renderRecordId();
      }
      const meta = record._connector;
      const fields = connectorEngine.CANONICAL_FIELDS.filter((field) =>
        record[field.key] !== undefined && record[field.key] !== null && record[field.key] !== '');
      const name = [record.firstName, record.middleName, record.lastName].filter(Boolean).join(' ') || `Record ${record.record_id}`;
      const freshnessText = meta.freshness === 'unknown'
        ? 'Source update time unavailable'
        : meta.stale
          ? `Source updated ${formatTimestamp(meta.sourceModifiedAt)} · may be stale`
          : `Source updated ${formatTimestamp(meta.sourceModifiedAt)}`;
      appRoot.innerHTML = `
      <section>
        <button class="back-button" type="button" data-action="back-record-id"><span aria-hidden="true">←</span> Back</button>
        <div class="intro">
          <p class="eyebrow">Review imported record</p>
          <h1>Confirm this client</h1>
          <p class="lede">Review every mapped value before it enters this browser session and becomes available to application forms.</p>
        </div>
        ${renderError()}
        <div class="connector-summary">
          <span class="connector-status-icon" aria-hidden="true">✓</span>
          <span><strong>${escapeHtml(name)}</strong><small>Record ${escapeHtml(record.record_id)} · ${escapeHtml(meta.organizationName)}</small></span>
        </div>
        <div class="record-preview-list">
          ${fields.map((field) => {
            const source = meta.provenance?.[field.key];
            return `
              <div class="record-preview-row">
                <span><strong>${escapeHtml(field.label)}</strong><small>${escapeHtml(source?.sourceLabel || 'Mapped source field')} · ${escapeHtml(source?.sourceFieldId || '')}</small></span>
                <span class="record-preview-value ${field.sensitive ? 'sensitive' : ''}">${escapeHtml(displayValue(field.key, record[field.key]))}</span>
              </div>`;
          }).join('')}
        </div>
        <div class="notice ${meta.stale ? 'warning' : ''}" style="margin-top:18px"><span aria-hidden="true">${meta.stale ? '!' : 'i'}</span><span>${escapeHtml(freshnessText)}. Retrieved ${escapeHtml(formatTimestamp(meta.retrievedAt))}.</span></div>
        <div class="form-actions">
          <button class="primary-button" type="button" data-action="confirm-connector-record">Use this reviewed record</button>
          <button class="secondary-button" type="button" data-action="back-record-id">Use a different record</button>
        </div>
      </section>`;
    }

    return {
      connectorTitle,
      connectorProvider,
      connectorSourceId,
      renderConnectorStatus,
      renderProviderCatalog,
      renderConnectorSetup,
      renderConnectorMapping,
      renderConnectorRecordReview,
    };
  }

  const api = { create };

  root.NavaConnectorViews = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
