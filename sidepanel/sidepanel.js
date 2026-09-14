(function startSidePanel() {
  'use strict';

  const appRoot = document.getElementById('app');
  const engine = globalThis.NavaFormEngine;
  const connectorEngine = globalThis.NavaConnectorEngine;
  const previewMode = new URLSearchParams(location.search).get('preview') === '1'
    || !globalThis.chrome?.runtime?.id;
  const demoMode = new URLSearchParams(location.search).get('demo') === '1';

  const state = {
    view: 'choice',
    error: '',
    participant: null,
    documentResult: null,
    activeTab: null,
    apps: [],
    currentAppId: null,
    previewPage: 1,
    connector: null,
    connectorDraft: null,
    connectorSchema: [],
    pendingConnectorRecord: null,
  };

  const MAX_AUTOMATED_PAGES = 12;

  const DEMO_RECORDS = {
    '339619': {
      record_id: '339619',
      participant: {
        name: { first: 'Celeste', middle: 'NAVA', last: 'Thomas II' },
        date_of_birth: '2000-01-02',
        ethnicity: 'Hispanic/Latino',
        gender: 'Female',
        primary_language: 'English',
        special_needs: false,
        marital_status: 'Single parent household',
      },
      contact_information: {
        preferred_method: null,
        phones: { cell: '777-777-7777' },
        email: 'testnava@email.com',
      },
      address: {
        residential: { street: '5556 Test Blvd', unit: 'Apt 556', city: 'WILDOMAR', state: 'California', county: 'Riverside', zip: '92595' },
        mailing: { street: '5556 Test Blvd', unit: 'Apt 556', city: 'WILDOMAR', state: 'California', county: 'Riverside', zip: '92595' },
      },
    },
  };

  const PREVIEW_CONNECTOR_SCHEMA = [
    { id: 101, label: 'First Name', type: 'text', reference_tag: 'firstName' },
    { id: 102, label: 'Middle Name', type: 'text', reference_tag: 'middleName' },
    { id: 103, label: 'Last Name', type: 'text', reference_tag: 'lastName' },
    { id: 104, label: 'Date of Birth', type: 'date', reference_tag: 'dateOfBirth' },
    { id: 105, label: 'Primary Email', type: 'email', reference_tag: 'email' },
    { id: 106, label: 'Cell Phone', type: 'phone', reference_tag: 'phone' },
    { id: 107, label: 'Residential Address', type: 'text', reference_tag: 'addressLine1' },
    { id: 108, label: 'Apartment or Unit', type: 'text', reference_tag: 'addressLine2' },
    { id: 109, label: 'Residential City', type: 'text', reference_tag: 'city' },
    { id: 110, label: 'Residential State', type: 'text', reference_tag: 'state' },
    { id: 111, label: 'Residential County', type: 'text', reference_tag: 'county' },
    { id: 112, label: 'ZIP Code', type: 'text', reference_tag: 'postalCode' },
    { id: 113, label: 'Preferred Language', type: 'select', reference_tag: 'primaryLanguage' },
  ];

  const PREVIEW_RAW_RECORD = {
    data: [{
      id: 339619,
      attributes: {
        form_id: 99,
        mod_time: new Date().toISOString(),
        field_101: 'Celeste',
        field_102: 'NAVA',
        field_103: 'Thomas II',
        field_104: '2000-01-02',
        field_105: 'testnava@email.com',
        field_106: '777-777-7777',
        field_107: '5556 Test Blvd',
        field_108: 'Apt 556',
        field_109: 'WILDOMAR',
        field_110: 'California',
        field_111: 'Riverside',
        field_112: '92595',
        field_113: 'English',
      },
    }],
  };

  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function encoded(value) {
    return encodeURIComponent(String(value));
  }

  function decoded(value) {
    return decodeURIComponent(String(value));
  }

  function sameValue(left, right) {
    return engine.normalize(left) === engine.normalize(right);
  }

  function displayValue(key, value) {
    if (['ssn', 'ein'].includes(key)) {
      const digits = String(value ?? '').replace(/\D/g, '');
      return digits.length >= 4 ? `••••${digits.slice(-4)}` : '••••';
    }
    return String(value ?? '');
  }

  function formatTimestamp(value) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? 'Unavailable' : date.toLocaleString();
  }

  function clientSummary() {
    return engine.canonicalizeParticipant(state.participant || {});
  }

  function firstName() {
    return clientSummary().values.firstName || clientSummary().name || 'Client';
  }

  function managedConnector() {
    return state.connector?.mode === 'managed';
  }

  function connectorTitle() {
    return managedConnector() ? state.connector.organizationName : 'Nava fictional test data';
  }

  function renderConnectorStatus() {
    const managed = managedConnector();
    const mapped = Object.keys(state.connector?.mappings || {}).length;
    return `
      <div class="connector-status ${managed ? 'connected' : ''}">
        <span class="connector-status-icon" aria-hidden="true">${managed ? '✓' : 'DB'}</span>
        <span><strong>${escapeHtml(connectorTitle())}</strong><small>${managed ? `Apricot 360 · ${mapped} mapped fields · read-only` : 'Bundled demo records · no external connection'}</small></span>
        <button class="link-button" type="button" data-action="configure-connector">${managed ? 'Manage' : 'Connect'}</button>
      </div>`;
  }

  function hostLabel(url) {
    try {
      return new URL(url).hostname.replace(/^www\./, '');
    } catch {
      return 'Current tab';
    }
  }

  async function getActiveTab() {
    if (previewMode) {
      return { id: 7001, title: 'Benefits application', url: `https://benefitscal.com/ApplyForBenefits/step-${state.previewPage}` };
    }
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab || null;
  }

  async function sendRuntime(message) {
    if (previewMode) return previewRuntime(message);
    return chrome.runtime.sendMessage(message);
  }

  async function ensurePageAgent(tab) {
    if (previewMode) return;
    if (!tab?.id || !/^https?:/i.test(tab.url || '')) {
      throw new Error('Open a regular website with a form, then try again. Chrome system pages cannot be filled.');
    }
    try {
      const pong = await chrome.tabs.sendMessage(tab.id, { type: 'NAVA_PING' });
      if (pong?.ok) return;
    } catch {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['shared/form-engine.js', 'content/form-agent.js'],
      });
    }
  }

  async function sendToTab(tab, message) {
    if (previewMode) return previewTabMessage(message);
    await ensurePageAgent(tab);
    return chrome.tabs.sendMessage(tab.id, message);
  }

  async function persist() {
    if (previewMode) return;
    await chrome.storage.session.set({
      'nava:session': {
        participant: state.participant,
        apps: state.apps,
        currentAppId: state.currentAppId,
      },
    });
  }

  async function restore() {
    if (previewMode) return;
    const result = await chrome.storage.session.get('nava:session');
    const saved = result['nava:session'];
    if (!saved?.participant) return;
    state.participant = saved.participant;
    state.apps = Array.isArray(saved.apps) ? saved.apps : [];
    state.currentAppId = saved.currentAppId || null;
    state.view = state.apps.length ? 'dashboard' : 'programs';
  }

  async function restoreConnector() {
    const response = await sendRuntime({ type: 'GET_CONNECTOR_STATUS' });
    if (!response?.ok) throw new Error(response?.error || 'The data-source status could not be loaded.');
    state.connector = response.connector;
  }

  function setBusy(message = 'Checking this form…') {
    appRoot.innerHTML = `
      <div class="loading">
        <div>
          <div class="spinner" aria-hidden="true"></div>
          <strong>${escapeHtml(message)}</strong>
        </div>
      </div>`;
  }

  function renderError() {
    return state.error
      ? `<div class="notice error" role="alert"><span aria-hidden="true">!</span><span>${escapeHtml(state.error)}</span></div>`
      : '';
  }

  function renderChoice() {
    appRoot.innerHTML = `
      <section>
        <div class="intro">
          <p class="eyebrow">Start a form</p>
          <h1>Let's find your client</h1>
          <p class="lede">Choose how you want to bring the client's information into this browser session.</p>
        </div>
        ${renderError()}
        ${renderConnectorStatus()}
        <div class="stack">
          <button class="choice-button" type="button" data-action="choose-id">
            <span class="choice-icon" aria-hidden="true">ID</span>
            <span class="choice-copy"><strong>I have their Apricot ID</strong><small>Use the record number to find their information.</small></span>
            <span class="chevron" aria-hidden="true">›</span>
          </button>
          <button class="choice-button" type="button" data-action="choose-json">
            <span class="choice-icon" aria-hidden="true">{ }</span>
            <span class="choice-copy"><strong>I don't have their Apricot ID</strong><small>Paste the client information as JSON.</small></span>
            <span class="chevron" aria-hidden="true">›</span>
          </button>
          <button class="choice-button" type="button" data-action="choose-document">
            <span class="choice-icon" aria-hidden="true">DOC</span>
            <span class="choice-copy"><strong>Upload a client or business document</strong><small>Review labeled details from PDF, Word, text, CSV, or JSON.</small></span>
            <span class="chevron" aria-hidden="true">›</span>
          </button>
        </div>
        <div class="notice" style="margin-top:16px"><span aria-hidden="true">i</span><span>${managedConnector() ? 'Record lookup uses the organization’s read-only connector. Credentials remain in the Nava connector service, never in Chrome.' : 'Connect a managed data source to replace fictional records. Credentials are never stored in this extension.'}</span></div>
      </section>`;
  }

  function renderRecordId() {
    appRoot.innerHTML = `
      <section>
        <button class="back-button" type="button" data-action="back-choice"><span aria-hidden="true">←</span> Back</button>
        <div class="intro">
          <p class="eyebrow">Client record</p>
          <h1>Let's find your client</h1>
          <p class="lede">Enter an Apricot 360 ID. We'll pull the record through ${escapeHtml(connectorTitle())}.</p>
        </div>
        ${renderError()}
        <form id="record-form" class="stack">
          <div class="field">
            <label for="record-id">Apricot 360 ID</label>
            <input id="record-id" name="recordId" type="text" inputmode="numeric" autocomplete="off" placeholder="Enter ID" required>
            <p class="field-hint">${managedConnector() ? `Read-only connector · form ${escapeHtml(state.connector.formId)} · ${Object.keys(state.connector.mappings || {}).length} mapped fields` : 'Prototype demo IDs: 339619, 338618, and 339637.'}</p>
          </div>
          <div class="form-actions">
            <button class="primary-button" type="submit">Continue</button>
            <button class="secondary-button" type="button" data-action="choose-json">Paste client JSON instead</button>
            <button class="link-button" type="button" data-action="configure-connector">Manage data source</button>
          </div>
        </form>
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
      formId: '',
      maxAgeDays: 30,
      mappings: {},
    };
  }

  function renderConnectorSetup() {
    const draft = connectorDraft();
    appRoot.innerHTML = `
      <section>
        <button class="back-button" type="button" data-action="back-choice"><span aria-hidden="true">←</span> Back</button>
        <div class="intro">
          <p class="eyebrow">Data source</p>
          <h1>Connect Apricot 360</h1>
          <p class="lede">Connect through a Nava-managed service, test access, and load the form’s labeled fields. API credentials remain on the service.</p>
        </div>
        ${renderError()}
        <div class="notice"><span aria-hidden="true">⌁</span><span>This extension accepts a connection ID, never an Apricot client secret, access token, password, or API key.</span></div>
        <form id="connector-form" class="stack connector-form">
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
              <label for="connector-form-id">Apricot form ID</label>
              <input id="connector-form-id" name="formId" type="number" min="1" value="${escapeHtml(draft.formId)}" required>
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
          <p class="lede">Suggestions use the source labels and reference tags. Review every mapping—numeric Apricot field IDs never determine meaning.</p>
        </div>
        ${renderError()}
        <div class="connector-summary">
          <span class="connector-status-icon" aria-hidden="true">✓</span>
          <span><strong>${escapeHtml(draft.organizationName)}</strong><small>${schema.length} labeled source fields loaded · form ${escapeHtml(draft.formId)}</small></span>
        </div>
        <form id="connector-mapping-form">
          ${categories.map((category) => `
            <p class="section-label">${escapeHtml(category)}</p>
            <div class="mapping-list">
              ${connectorEngine.CANONICAL_FIELDS.filter((field) => field.category === category).map((canonical) => `
                <label class="mapping-row">
                  <span><strong>${escapeHtml(canonical.label)}</strong>${canonical.sensitive ? '<small>Sensitive · masked in review</small>' : '<small>Canonical destination</small>'}</span>
                  <select name="map-${escapeHtml(canonical.key)}" aria-label="Apricot field for ${escapeHtml(canonical.label)}">
                    <option value="">Not mapped</option>
                    ${schema.map((field) => `<option value="${escapeHtml(field.id)}" ${draft.mappings?.[canonical.key] === field.id ? 'selected' : ''}>${escapeHtml(field.label)} — ${escapeHtml(field.id)}</option>`).join('')}
                  </select>
                </label>`).join('')}
            </div>`).join('')}
          <div class="notice warning" style="margin-top:18px"><span aria-hidden="true">!</span><span>Saving authorizes read-only lookup through this mapping. It does not grant the extension permission to edit Apricot.</span></div>
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

  function renderJsonImport() {
    appRoot.innerHTML = `
      <section>
        <button class="back-button" type="button" data-action="back-choice"><span aria-hidden="true">←</span> Back</button>
        <div class="intro">
          <p class="eyebrow">Client data</p>
          <h1>Paste the client record</h1>
          <p class="lede">Use labeled JSON fields. The assistant will never guess a missing value.</p>
        </div>
        ${renderError()}
        <form id="json-form" class="stack">
          <div class="field">
            <label for="client-json">Client information</label>
            <textarea id="client-json" name="clientJson" spellcheck="false" placeholder='{"firstName":"Maria","lastName":"Santos"}' required></textarea>
          </div>
          <button class="link-button" type="button" data-action="use-sample">Use a fictional sample record</button>
          <div class="form-actions">
            <button class="primary-button" type="submit">Continue</button>
          </div>
        </form>
      </section>`;
  }

  function renderDocumentUpload() {
    const backAction = state.participant ? 'back-programs' : 'back-choice';
    appRoot.innerHTML = `
      <section>
        <button class="back-button" type="button" data-action="${backAction}"><span aria-hidden="true">←</span> Back</button>
        <div class="intro">
          <p class="eyebrow">Document intake</p>
          <h1>Upload a client or business document</h1>
          <p class="lede">The assistant reads the file locally and proposes only clearly labeled fields. You choose what to add before anything is used.</p>
        </div>
        ${renderError()}
        <form id="document-form" class="stack">
          <label class="upload-zone" for="client-document">
            <span class="upload-icon" aria-hidden="true">↑</span>
            <strong>Choose a document</strong>
            <span>PDF, DOCX, TXT, CSV, TSV, or JSON · up to 15 MB</span>
            <input id="client-document" name="clientDocument" type="file" accept=".pdf,.docx,.txt,.csv,.tsv,.json,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain,text/csv,application/json" required>
          </label>
          <div class="notice"><span aria-hidden="true">⌁</span><span>The raw file stays on this device and is discarded after parsing. Scanned PDFs without selectable text are not supported in this build.</span></div>
          <div class="form-actions">
            <button class="primary-button" type="submit">Read document</button>
            ${state.participant ? '' : '<button class="secondary-button" type="button" data-action="choose-json">Paste JSON instead</button>'}
          </div>
        </form>
      </section>`;
  }

  function renderDocumentReview() {
    const result = state.documentResult;
    if (!result) {
      state.view = 'document';
      return renderDocumentUpload();
    }
    const current = clientSummary().values;
    const conflictCount = result.fields.filter((field) => {
      const existing = current[field.key];
      return existing !== undefined && existing !== null && existing !== '' && !sameValue(existing, field.value);
    }).length;
    appRoot.innerHTML = `
      <section>
        <button class="back-button" type="button" data-action="back-document"><span aria-hidden="true">←</span> Back</button>
        <div class="intro">
          <p class="eyebrow">Review extracted details</p>
          <h1>Choose what to add</h1>
          <p class="lede">Nothing is merged until you confirm it. Sensitive identifiers are masked here and on later review screens.</p>
        </div>
        ${renderError()}
        <div class="file-summary">
          <span class="file-badge" aria-hidden="true">DOC</span>
          <span><strong>${escapeHtml(result.file.name)}</strong><small>${result.fields.length} proposed ${result.fields.length === 1 ? 'field' : 'fields'}${conflictCount ? ` · ${conflictCount} ${conflictCount === 1 ? 'conflict' : 'conflicts'}` : ''}</small></span>
        </div>
        ${result.warnings.map((warning) => `<div class="notice warning document-warning"><span aria-hidden="true">!</span><span>${escapeHtml(warning)}</span></div>`).join('')}
        ${result.fields.length ? `
          <form id="document-review-form">
            <div class="extraction-list">
              ${result.fields.map((field, index) => {
                const existing = current[field.key];
                const hasExisting = existing !== undefined && existing !== null && existing !== '';
                const conflict = hasExisting && !sameValue(existing, field.value);
                return `
                  <label class="extraction-card ${conflict ? 'conflict' : ''}">
                    <input type="checkbox" name="fieldIndex" value="${index}" ${conflict ? '' : 'checked'}>
                    <span class="extraction-copy">
                      <span class="extraction-heading"><strong>${escapeHtml(field.label)}</strong><span class="confidence-chip ${escapeHtml(field.confidence)}">${escapeHtml(field.confidence)}</span></span>
                      <span class="extracted-value">${escapeHtml(field.displayValue)}</span>
                      <small>${escapeHtml(field.evidence)}</small>
                      ${conflict ? `<span class="conflict-note"><strong>Different from current:</strong> ${escapeHtml(displayValue(field.key, existing))}. Select to replace it.</span>` : ''}
                    </span>
                  </label>`;
              }).join('')}
            </div>
            <div class="form-actions">
              <button class="primary-button" type="submit">Use selected details</button>
              <button class="secondary-button" type="button" data-action="back-document">Choose another file</button>
            </div>
          </form>` : `
          <div class="form-actions">
            <button class="primary-button" type="button" data-action="back-document">Choose another file</button>
            <button class="secondary-button" type="button" data-action="choose-json">Paste JSON instead</button>
          </div>`}
      </section>`;
  }

  function renderPrograms() {
    const client = clientSummary();
    const connectorMeta = state.participant?._connector;
    const tabUrl = state.activeTab?.url || '';
    const currentAllowed = /^https?:/i.test(tabUrl);
    appRoot.innerHTML = `
      <section>
        <button class="back-button" type="button" data-action="${state.apps.length ? 'back-dashboard' : 'change-client'}"><span aria-hidden="true">←</span> ${state.apps.length ? 'Back' : 'Change client'}</button>
        <div class="intro">
          <p class="eyebrow">Applications</p>
          <h1>What should I help with?</h1>
          <p class="lede">Choose this tab or open one of the known application sites. Each application stays in its own tab.</p>
        </div>
        ${renderError()}
        <div class="client-chip">
          <div><strong>${escapeHtml(client.name)}</strong><span>${client.recordId ? `Record ${escapeHtml(client.recordId)}` : state.participant?._documentSources?.length ? 'Document import' : 'Pasted client record'}${connectorMeta ? ` · ${escapeHtml(connectorMeta.organizationName)}` : ''}</span>${connectorMeta ? `<span class="source-freshness ${connectorMeta.stale ? 'stale' : ''}">${connectorMeta.freshness === 'unknown' ? 'Source freshness unavailable' : connectorMeta.stale ? 'Source record may be stale' : `Retrieved ${escapeHtml(formatTimestamp(connectorMeta.retrievedAt))}`}</span>` : ''}</div>
          <div class="client-actions">
            <button class="link-button" type="button" data-action="choose-document">Add document</button>
            <button class="link-button" type="button" data-action="change-client">Change</button>
          </div>
        </div>
        <form id="program-form">
          <p class="section-label">This browser tab</p>
          <div class="program-list">
            <label class="program-option">
              <input type="checkbox" name="program" value="current" ${currentAllowed ? 'checked' : 'disabled'}>
              <span><strong>Analyze this form</strong><small>${escapeHtml(currentAllowed ? hostLabel(tabUrl) : 'Open a website first')}</small></span>
            </label>
          </div>
          <p class="section-label">Known application sites</p>
          <div class="program-list">
            ${[
              ['calfresh', 'CalFresh', 'BenefitsCal'],
              ['medical', 'Medi-Cal', 'BenefitsCal'],
              ['wic', 'WIC', 'Riverside University Health System'],
              ['calworks', 'CalWORKs', 'BenefitsCal'],
              ['ihss', 'IHSS', 'Riverside County'],
            ].map(([value, name, source]) => `
              <label class="program-option">
                <input type="checkbox" name="program" value="${value}">
                <span><strong>${name}</strong><small>${source}</small></span>
              </label>`).join('')}
          </div>
          <div class="form-actions">
            <button class="primary-button" type="submit">Continue</button>
          </div>
        </form>
      </section>`;
  }

  function progressFor(application) {
    if (application.status === 'ready_for_review') return 100;
    if (application.status === 'needs_attention') return 55;
    if (application.status === 'ready_to_fill') return 35;
    return 8;
  }

  function statusLabel(application) {
    if (application.status === 'ready_for_review') return 'Ready for review';
    if (application.status === 'needs_attention') return 'Needs your attention';
    if (application.status === 'ready_to_fill') return 'Ready to fill';
    if (application.status === 'no_form') return 'No form found';
    return 'Not started';
  }

  function applicationCard(application) {
    const review = application.status === 'ready_for_review';
    const attention = ['needs_attention', 'no_form'].includes(application.status);
    const gaps = application.analysis?.gaps?.length || 0;
    const blocked = application.blocked?.length || 0;
    const completedPages = application.completedPages?.length || 0;
    const note = application.error
      || (blocked ? `${blocked} fields need direct help` : '')
      || (gaps ? `${gaps} answers are needed before this page is complete` : '')
      || (review ? (application.runStopReason || 'All writes were read back and verified') : 'Ready to fill the values found in the client record');
    let actions = '';
    if (attention && gaps) {
      actions = `<button class="small-button" type="button" data-action="answer-run" data-app="${encoded(application.id)}">Answer and continue</button>
        <button class="small-button secondary" type="button" data-action="answer" data-app="${encoded(application.id)}">This page only</button>`;
    } else if (application.status === 'ready_to_fill') {
      actions = `<button class="small-button" type="button" data-action="run" data-app="${encoded(application.id)}">Fill through application</button>
        <button class="small-button secondary" type="button" data-action="fill" data-app="${encoded(application.id)}">This page only</button>`;
    } else if (review) {
      actions = `<button class="small-button secondary" type="button" data-action="review" data-app="${encoded(application.id)}">Review details</button>`;
    } else {
      actions = `<button class="small-button" type="button" data-action="analyze-current">Analyze current tab</button>`;
    }
    if (application.tabId) actions += `<button class="small-button secondary" type="button" data-action="go-tab" data-app="${encoded(application.id)}">Go to application</button>`;

    return `
      <article class="application-card ${attention ? 'attention' : ''} ${review ? 'review' : ''}">
        <div class="card-row">
          <div class="card-heading">
            <span class="status-icon" aria-hidden="true">${review ? '✓' : attention ? '!' : '•'}</span>
            <div><strong>${escapeHtml(application.name)}</strong><p class="card-note">${escapeHtml(hostLabel(application.url))}</p></div>
          </div>
          <div aria-label="${progressFor(application)} percent complete" class="progress-track"><div class="progress-fill" style="width:${progressFor(application)}%"></div></div>
        </div>
        <p class="card-note"><strong>${escapeHtml(statusLabel(application))}.</strong> ${escapeHtml(note)}</p>
        ${completedPages ? `<p class="automation-badge">✓ ${completedPages} page${completedPages === 1 ? '' : 's'} completed automatically</p>` : ''}
        <div class="card-actions">${actions}</div>
      </article>`;
  }

  function renderDashboard() {
    const groups = [
      ['NEEDS YOUR ATTENTION', state.apps.filter((item) => ['needs_attention', 'no_form'].includes(item.status))],
      ['IN PROGRESS', state.apps.filter((item) => ['not_started', 'ready_to_fill'].includes(item.status))],
      ['READY FOR REVIEW', state.apps.filter((item) => item.status === 'ready_for_review')],
    ];
    appRoot.innerHTML = `
      <section>
        <div class="intro">
          <p class="eyebrow">Application dashboard</p>
          <h1>${escapeHtml(firstName())}'s applications</h1>
          <p class="lede">The assistant can continue across approved application pages. It always stops before certification, signature, or submission.</p>
        </div>
        ${renderError()}
        ${groups.map(([label, apps]) => apps.length ? `
          <p class="section-label">${label}</p>
          <div class="stack">${apps.map(applicationCard).join('')}</div>` : '').join('')}
        ${state.apps.length ? '' : '<div class="notice"><span>i</span><span>No application has been added yet.</span></div>'}
        <div class="form-actions">
          <button class="secondary-button" type="button" data-action="add-application">Add another application</button>
          <button class="link-button" type="button" data-action="start-over">End this session</button>
        </div>
      </section>`;
  }

  function choiceOptions(gap) {
    const options = (gap.options || []).map((option) => ({
      value: option.value ?? option.optionLabel ?? option.label,
      label: option.optionLabel ?? option.label ?? option.value,
    })).filter((option) => option.value !== undefined && option.value !== '');
    if (!options.length && gap.kind === 'decision') {
      return [{ value: 'yes', label: 'Yes' }, { value: 'no', label: 'No' }];
    }
    return options;
  }

  function renderQuestions() {
    const application = state.apps.find((item) => item.id === state.currentAppId);
    if (!application) {
      state.view = 'dashboard';
      return renderDashboard();
    }
    appRoot.innerHTML = `
      <section>
        <button class="back-button" type="button" data-action="back-dashboard"><span aria-hidden="true">←</span> Back</button>
        <div class="intro">
          <p class="eyebrow">${escapeHtml(application.name)}</p>
          <h1>Answer the missing questions</h1>
          <p class="lede">Your answers go directly into the application. Leave a field blank if you do not know it—the assistant will not guess.${application.autoRun ? ' After this page is verified, the assistant will continue through approved next steps.' : ''}</p>
        </div>
        ${application.playbook ? `<div class="notice"><span aria-hidden="true">i</span><span>${escapeHtml(application.playbook.note)}</span></div>` : ''}
        <form id="questions-form">
          <div class="question-list">
            ${(application.analysis?.gaps || []).map((gap, index) => {
              const name = `answer-${index}`;
              const options = choiceOptions(gap);
              return `
                <div class="question-card">
                  <div><p class="question-title">${escapeHtml(gap.question)}</p>${gap.required ? '<p class="field-hint">The form marks this as required.</p>' : ''}</div>
                  ${gap.inputType === 'choice' && options.length ? `
                    <div class="choice-grid">
                      ${options.map((option) => `
                        <label class="choice-pill">
                          <input type="radio" name="${name}" value="${escapeHtml(option.value)}">
                          <span>${escapeHtml(option.label)}</span>
                        </label>`).join('')}
                    </div>` : `
                    <input type="text" name="${name}" autocomplete="off" ${gap.sensitive ? 'inputmode="numeric"' : ''} aria-label="${escapeHtml(gap.question)}">`}
                  <input type="hidden" name="field-${index}" value="${escapeHtml(gap.fieldKey)}">
                </div>`;
            }).join('')}
          </div>
          <div class="form-actions">
            <button class="primary-button" type="submit">${application.autoRun ? 'Fill and continue automatically' : 'Fill this page'}</button>
          </div>
        </form>
      </section>`;
  }

  function sourceLabel(source) {
    return { record: 'Record', changed: 'Changed', user: 'You', page: 'On page', empty: 'Empty' }[source] || source;
  }

  function renderReview() {
    const application = state.apps.find((item) => item.id === state.currentAppId);
    if (!application) {
      state.view = 'dashboard';
      return renderDashboard();
    }
    const completedPages = application.completedPages || [];
    const pageSnapshots = [
      ...completedPages,
      { title: application.page?.title || application.name, provenance: application.provenance || [], empty: application.empty || [], noFields: application.analysis?.noFields || [] },
    ];
    const rows = pageSnapshots.flatMap((page) => [
      ...(page.provenance || []).map((item) => ({ ...item, pageTitle: page.title })),
      ...(page.empty || []).map((item) => ({ label: item.label, value: '(empty)', source: 'empty', detail: item.reason || 'No value was provided', pageTitle: page.title })),
    ]);
    const verified = pageSnapshots.reduce((sum, page) => sum + (page.provenance?.length || 0), 0);
    const empty = pageSnapshots.reduce((sum, page) => sum + (page.empty?.length || 0), 0);
    const noFieldLists = pageSnapshots.map((page) => page.noFields || []);
    const unusedEntries = (noFieldLists[0] || []).filter((candidate) =>
      noFieldLists.every((items) => items.some((item) => item.purpose === candidate.purpose)));
    const unused = unusedEntries.length;
    const gate = application.submitGate || {};
    const stopReason = application.runStopReason || application.navigationGate?.reason || gate.blockedReason
      || 'The assistant will not submit this application. Review the page, complete any affirmation or bot check, and submit it yourself.';
    appRoot.innerHTML = `
      <section>
        <button class="back-button" type="button" data-action="back-dashboard"><span aria-hidden="true">←</span> Back</button>
        <div class="intro">
          <p class="eyebrow">${escapeHtml(application.name)}</p>
          <h1>Review what was filled</h1>
          <p class="lede">Every changed value below was read back from the form. The assistant stopped before the final action so a caseworker can review and submit.</p>
        </div>
        <div class="summary-grid">
          <div class="summary-card"><strong>${verified}</strong><span>Verified</span></div>
          <div class="summary-card"><strong>${empty}</strong><span>Empty</span></div>
          <div class="summary-card"><strong>${pageSnapshots.length}</strong><span>Pages</span></div>
        </div>
        ${completedPages.length ? `<ol class="page-progress-list">${pageSnapshots.map((page, index) => `<li><span>Page ${index + 1}</span><strong>${escapeHtml(page.title || 'Application page')}</strong></li>`).join('')}</ol>` : ''}
        <div class="table-wrap">
          <table class="review-table">
            <thead><tr><th style="width:34%">Field</th><th style="width:36%">Value</th><th style="width:30%">Source</th></tr></thead>
            <tbody>${rows.map((row) => `
              <tr>
                <td><span class="review-page">${escapeHtml(row.pageTitle || '')}</span>${escapeHtml(row.label)}</td>
                <td title="${escapeHtml(row.detail || '')}">${escapeHtml(row.value)}</td>
                <td><span class="source-chip ${escapeHtml(row.source)}">${escapeHtml(sourceLabel(row.source))}</span></td>
              </tr>`).join('')}</tbody>
          </table>
        </div>
        ${unused ? `<p class="card-note" style="margin-top:12px">No matching field in this flow: ${unusedEntries.map((item) => escapeHtml(item.label)).join(', ')}.</p>` : ''}
        <div class="notice warning" style="margin-top:18px"><span aria-hidden="true">!</span><span>${escapeHtml(stopReason)}</span></div>
        <div class="form-actions">
          <button class="primary-button" type="button" data-action="go-tab" data-app="${encoded(application.id)}">Go to application</button>
          <button class="secondary-button" type="button" data-action="rescan" data-app="${encoded(application.id)}">Scan this page again</button>
        </div>
      </section>`;
  }

  function render() {
    const renderView = {
      connector: renderConnectorSetup,
      'connector-mapping': renderConnectorMapping,
      'record-review': renderConnectorRecordReview,
      record: renderRecordId,
      json: renderJsonImport,
      document: renderDocumentUpload,
      'document-review': renderDocumentReview,
      programs: renderPrograms,
      dashboard: renderDashboard,
      questions: renderQuestions,
      review: renderReview,
    }[state.view] || renderChoice;
    renderView();
    const resetScroll = () => {
      if (document.scrollingElement) document.scrollingElement.scrollTop = 0;
      appRoot.scrollTop = 0;
    };
    resetScroll();
    requestAnimationFrame(() => requestAnimationFrame(resetScroll));
    setTimeout(resetScroll, 100);
  }

  async function lookupRecord(recordId) {
    setBusy('Finding the client record…');
    const response = await sendRuntime({ type: 'LOOKUP_RECORD', recordId });
    if (!response?.ok || !response.record) throw new Error(response?.message || 'No client record was found.');
    if (response.record._connector) {
      state.pendingConnectorRecord = response.record;
      state.view = 'record-review';
      return;
    }
    state.participant = response.record;
    state.activeTab = await getActiveTab();
    state.view = 'programs';
    await persist();
  }

  async function scanTab(tab, { quiet = false } = {}) {
    if (!quiet) setBusy('Checking this form and its required fields…');
    const response = await sendToTab(tab, { type: 'NAVA_SCAN', participant: state.participant });
    if (!response?.ok) throw new Error(response?.error || 'The form could not be read.');
    const id = `tab:${tab.id}`;
    const previous = state.apps.find((item) => item.id === id) || {};
    const fieldsFound = response.analysis?.counts?.fields || 0;
    const canContinue = response.navigationGate?.kind === 'next';
    const application = {
      ...previous,
      id,
      tabId: tab.id,
      name: response.playbook?.name || response.page?.title || hostLabel(tab.url),
      url: response.page?.url || tab.url,
      page: response.page,
      status: fieldsFound === 0 && !canContinue
        ? 'no_form'
        : response.analysis.gaps.length
          ? 'needs_attention'
          : 'ready_to_fill',
      analysis: response.analysis,
      playbook: response.playbook,
      submitGate: response.submitGate,
      navigationGate: response.navigationGate,
      error: fieldsFound === 0 && !canContinue ? 'No visible application fields or safe continuation controls were found on this page.' : '',
      provenance: [],
      blocked: [],
      empty: [],
      completedPages: previous.completedPages || [],
      autoRun: Boolean(previous.autoRun),
      visitedSignatures: previous.visitedSignatures || [],
      updatedAt: new Date().toISOString(),
    };
    const existing = state.apps.findIndex((item) => item.id === id);
    if (existing >= 0) state.apps.splice(existing, 1, application);
    else state.apps.unshift(application);
    state.currentAppId = id;
    state.view = 'dashboard';
    await persist();
    return application;
  }

  async function openSelectedPrograms(values) {
    const known = values.filter((value) => value !== 'current');
    if (!known.length) return;
    const response = await sendRuntime({ type: 'OPEN_PROGRAMS', programs: known });
    if (!response?.ok) throw new Error(response?.error || 'The application tabs could not be opened.');
    response.opened.forEach((item) => {
      state.apps.push({
        id: `tab:${item.tabId}`,
        tabId: item.tabId,
        name: item.name,
        url: item.url,
        status: 'not_started',
        updatedAt: new Date().toISOString(),
      });
    });
  }

  async function fillCurrentPage(application, userAssignments = [], unresolved = []) {
    const tab = previewMode
      ? { id: application.tabId, url: application.url }
      : await chrome.tabs.get(application.tabId);
    setBusy('Filling the page and checking every value…');
    const assignments = [...(application.analysis?.assignments || []), ...userAssignments];
    const response = await sendToTab(tab, { type: 'NAVA_FILL', assignments });
    if (!response?.ok) throw new Error(response?.error || 'The page could not be filled.');
    const provenanceByField = new Map();
    [...(application.provenance || []), ...(application.analysis?.observed || []), ...(response.provenance || [])]
      .forEach((item) => provenanceByField.set(item.fieldKey, item));
    application.provenance = [...provenanceByField.values()];
    application.blocked = (response.results || []).filter((item) => item.status !== 'verified');
    application.empty = [
      ...unresolved.map((gap) => ({ label: gap.label, reason: 'No answer was provided.' })),
      ...application.blocked.map((item) => ({ label: item.label, reason: item.reason })),
    ];
    application.submitGate = response.submitGate || application.submitGate;
    application.navigationGate = response.navigationGate || application.navigationGate;
    application.analysis.gaps = unresolved;
    application.status = application.empty.length ? 'needs_attention' : 'ready_to_fill';
    application.updatedAt = new Date().toISOString();
    state.currentAppId = application.id;
    await persist();
    return response;
  }

  function archiveCurrentPage(application) {
    const signature = application.navigationGate?.pageSignature || `${application.page?.url || application.url}|${application.page?.title || application.name}`;
    if (application.completedPages?.some((page) => page.signature === signature)) return;
    application.completedPages = [
      ...(application.completedPages || []),
      {
        signature,
        title: application.page?.title || application.name,
        url: application.page?.url || application.url,
        provenance: application.provenance || [],
        empty: application.empty || [],
        noFields: application.analysis?.noFields || [],
        completedAt: new Date().toISOString(),
      },
    ];
  }

  async function navigationStatusFor(tab) {
    const response = await sendToTab(tab, { type: 'NAVA_NAVIGATION_STATUS' });
    if (!response?.ok) throw new Error(response?.error || 'The next-step control could not be checked.');
    return response.navigationGate;
  }

  async function waitForNextPage(tabId, previousSignature) {
    if (previewMode) return { id: tabId, url: `https://benefitscal.com/ApplyForBenefits/step-${state.previewPage}` };
    for (let attempt = 0; attempt < 25; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 400));
      try {
        const tab = await chrome.tabs.get(tabId);
        if (tab.status !== 'complete') continue;
        const gate = await navigationStatusFor(tab);
        if (gate?.pageSignature && gate.pageSignature !== previousSignature) return tab;
      } catch {
        // Full-page navigations briefly disconnect the content agent. Keep polling.
      }
    }
    throw new Error('The site did not reach a new page after the safe continuation control was activated. The assistant stopped so the caseworker can inspect the application.');
  }

  async function runThroughApplication(application, userAssignments = [], unresolved = []) {
    application.autoRun = true;
    application.runStopReason = '';
    let current = application;
    let suppliedAssignments = userAssignments;
    let suppliedUnresolved = unresolved;

    for (;;) {
      if ((current.analysis?.gaps?.length || 0) && !suppliedAssignments.length && !suppliedUnresolved.length) {
        current.status = 'needs_attention';
        state.currentAppId = current.id;
        state.view = 'questions';
        await persist();
        return;
      }

      await fillCurrentPage(current, suppliedAssignments, suppliedUnresolved);
      suppliedAssignments = [];
      suppliedUnresolved = [];

      if (current.empty.length || current.blocked.length) {
        current.status = 'needs_attention';
        current.runStopReason = 'The automated run paused because at least one field needs a caseworker answer or direct entry.';
        state.view = 'dashboard';
        await persist();
        return;
      }

      const tab = previewMode
        ? { id: current.tabId, url: current.url }
        : await chrome.tabs.get(current.tabId);
      current.navigationGate = await navigationStatusFor(tab);

      if (current.navigationGate?.kind !== 'next') {
        current.status = 'ready_for_review';
        current.runStopReason = current.navigationGate?.reason || 'No approved continuation control is visible. Review the application before taking the next action.';
        current.autoRun = false;
        state.currentAppId = current.id;
        state.view = 'review';
        await persist();
        return;
      }

      if ((current.completedPages?.length || 0) >= MAX_AUTOMATED_PAGES - 1) {
        current.status = 'needs_attention';
        current.runStopReason = `The assistant reached its ${MAX_AUTOMATED_PAGES}-page safety limit and stopped.`;
        current.error = current.runStopReason;
        current.autoRun = false;
        state.view = 'dashboard';
        await persist();
        return;
      }

      const signature = current.navigationGate.pageSignature;
      if (current.visitedSignatures?.includes(signature)) {
        current.status = 'needs_attention';
        current.runStopReason = 'The application returned to a page it already completed. The assistant stopped to avoid a navigation loop.';
        current.error = current.runStopReason;
        current.autoRun = false;
        state.view = 'dashboard';
        await persist();
        return;
      }

      setBusy(`Page ${(current.completedPages?.length || 0) + 1} verified. Moving to the next page…`);
      const advanced = await sendToTab(tab, { type: 'NAVA_ADVANCE' });
      if (!advanced?.ok || !advanced.advanced) {
        throw new Error(advanced?.navigationGate?.reason || 'The approved continuation control was no longer available.');
      }
      const nextTab = await waitForNextPage(current.tabId, signature);
      current.visitedSignatures = [...(current.visitedSignatures || []), signature];
      archiveCurrentPage(current);
      await persist();
      current = await scanTab(nextTab, { quiet: true });
      current.autoRun = true;
    }
  }

  async function fillApplication(application, userAssignments = [], unresolved = []) {
    application.autoRun = false;
    application.runStopReason = '';
    await fillCurrentPage(application, userAssignments, unresolved);
    application.status = application.empty.length ? 'needs_attention' : 'ready_for_review';
    application.runStopReason = application.navigationGate?.reason || '';
    state.view = application.status === 'ready_for_review' ? 'review' : 'dashboard';
    await persist();
  }

  async function goToApplication(application) {
    if (previewMode) return;
    const tab = await chrome.tabs.get(application.tabId);
    await chrome.tabs.update(application.tabId, { active: true });
    if (tab.windowId) await chrome.windows.update(tab.windowId, { focused: true });
  }

  async function onClick(button) {
    const action = button.dataset.action;
    state.error = '';
    if (action === 'close') {
      window.close();
      return;
    }
    if (action === 'choose-id') state.view = 'record';
    if (action === 'choose-json') state.view = 'json';
    if (action === 'configure-connector') {
      state.connectorDraft = null;
      state.connectorSchema = [];
      state.pendingConnectorRecord = null;
      state.view = 'connector';
    }
    if (action === 'back-connector') state.view = 'connector';
    if (action === 'local-connector-settings') {
      document.getElementById('connector-org').value = 'Riverside Community Services';
      document.getElementById('connector-url').value = 'http://127.0.0.1:4789';
      document.getElementById('connection-id').value = 'nava-demo';
      document.getElementById('connector-form-id').value = '99';
      return;
    }
    if (action === 'reset-connector') {
      setBusy('Disconnecting the data source…');
      const response = await sendRuntime({ type: 'RESET_CONNECTOR' });
      if (!response?.ok) throw new Error(response?.error || 'The connector could not be removed.');
      state.connector = response.connector;
      state.connectorDraft = null;
      state.connectorSchema = [];
      state.pendingConnectorRecord = null;
      state.view = 'choice';
    }
    if (action === 'choose-document') {
      state.documentResult = null;
      state.view = 'document';
    }
    if (action === 'back-choice') state.view = 'choice';
    if (action === 'back-record-id') {
      state.pendingConnectorRecord = null;
      state.view = 'record';
    }
    if (action === 'confirm-connector-record') {
      if (!state.pendingConnectorRecord) throw new Error('Retrieve and review a connector record first.');
      state.participant = state.pendingConnectorRecord;
      state.pendingConnectorRecord = null;
      state.activeTab = await getActiveTab();
      state.view = 'programs';
      await persist();
    }
    if (action === 'back-programs') state.view = 'programs';
    if (action === 'back-document') {
      state.documentResult = null;
      state.view = 'document';
    }
    if (action === 'change-client') {
      state.participant = null;
      state.documentResult = null;
      state.pendingConnectorRecord = null;
      state.apps = [];
      state.currentAppId = null;
      state.previewPage = 1;
      state.view = 'choice';
      if (!previewMode) await chrome.storage.session.remove('nava:session');
    }
    if (action === 'back-dashboard') state.view = 'dashboard';
    if (action === 'add-application') {
      state.activeTab = await getActiveTab();
      state.view = 'programs';
    }
    if (action === 'use-sample') {
      document.getElementById('client-json').value = JSON.stringify(DEMO_RECORDS['339619'], null, 2);
      return;
    }
    if (action === 'start-over') {
      state.participant = null;
      state.documentResult = null;
      state.pendingConnectorRecord = null;
      state.apps = [];
      state.currentAppId = null;
      state.previewPage = 1;
      state.view = 'choice';
      if (!previewMode) await chrome.storage.session.remove('nava:session');
    }
    if (['answer', 'answer-run', 'fill', 'run', 'review', 'rescan', 'go-tab'].includes(action)) {
      const id = decoded(button.dataset.app);
      const application = state.apps.find((item) => item.id === id);
      if (!application) throw new Error('That application is no longer available.');
      state.currentAppId = id;
      if (action === 'answer' || action === 'answer-run') {
        application.autoRun = action === 'answer-run';
        state.view = 'questions';
      }
      if (action === 'fill') await fillApplication(application);
      if (action === 'run') await runThroughApplication(application);
      if (action === 'review') state.view = 'review';
      if (action === 'rescan') {
        const tab = previewMode ? { id: application.tabId, url: application.url } : await chrome.tabs.get(application.tabId);
        await scanTab(tab);
      }
      if (action === 'go-tab') await goToApplication(application);
    }
    if (action === 'analyze-current') {
      state.activeTab = await getActiveTab();
      await scanTab(state.activeTab);
    }
    render();
  }

  async function onSubmit(form) {
    state.error = '';
    if (form.id === 'connector-form') {
      const data = new FormData(form);
      const config = {
        provider: 'apricot360',
        organizationName: String(data.get('organizationName') || '').trim(),
        backendUrl: String(data.get('backendUrl') || '').trim(),
        connectionId: String(data.get('connectionId') || '').trim(),
        formId: Number(data.get('formId')),
        maxAgeDays: Number(data.get('maxAgeDays')),
        mappings: managedConnector() ? state.connector.mappings : {},
        mappingVersion: managedConnector() ? Number(state.connector.mappingVersion || 1) + 1 : 1,
      };
      setBusy('Testing the connector and loading labeled fields…');
      const response = await sendRuntime({ type: 'DISCOVER_CONNECTOR', config });
      if (!response?.ok) throw new Error(response?.error || 'The connector could not be verified.');
      state.connectorDraft = { ...response.config, mappings: response.suggestions || {} };
      state.connectorSchema = response.schema || [];
      state.view = 'connector-mapping';
    }
    if (form.id === 'connector-mapping-form') {
      const data = new FormData(form);
      const mappings = {};
      connectorEngine.CANONICAL_FIELDS.forEach((field) => {
        const source = String(data.get(`map-${field.key}`) || '').trim();
        if (source) mappings[field.key] = source;
      });
      const config = { ...state.connectorDraft, mappings };
      setBusy('Saving the reviewed field mapping…');
      const response = await sendRuntime({ type: 'SAVE_CONNECTOR', config, schema: state.connectorSchema });
      if (!response?.ok) throw new Error(response?.error || 'The connector mapping could not be saved.');
      state.connector = response.connector;
      state.connectorDraft = null;
      state.connectorSchema = [];
      state.view = 'choice';
    }
    if (form.id === 'record-form') {
      await lookupRecord(new FormData(form).get('recordId'));
    }
    if (form.id === 'json-form') {
      const raw = new FormData(form).get('clientJson');
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch {
        throw new Error('That is not valid JSON. Check the commas and quotation marks, then try again.');
      }
      if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') throw new Error('Paste one client record as a JSON object.');
      state.participant = parsed;
      state.activeTab = await getActiveTab();
      state.view = 'programs';
      await persist();
    }
    if (form.id === 'document-form') {
      const file = form.elements.clientDocument?.files?.[0];
      setBusy('Reading the document on this device…');
      state.documentResult = await globalThis.NavaDocumentParser.parseDocument(file);
      state.view = 'document-review';
    }
    if (form.id === 'document-review-form') {
      const result = state.documentResult;
      if (!result) throw new Error('Choose and read a document first.');
      const selectedIndexes = new FormData(form).getAll('fieldIndex').map(Number);
      if (!selectedIndexes.length) throw new Error('Select at least one detail to use.');
      const selected = selectedIndexes.map((index) => result.fields[index]).filter(Boolean);
      const currentValues = state.participant ? clientSummary().values : {};
      const existing = Object.fromEntries(Object.entries(currentValues).filter(([, value]) => value !== undefined && value !== null && value !== ''));
      const additions = Object.fromEntries(selected.map((field) => [field.key, field.value]));
      state.participant = {
        ...existing,
        ...additions,
        _documentSources: [
          ...(state.participant?._documentSources || []),
          { name: result.file.name, fields: selected.map((field) => field.key) },
        ],
      };
      state.documentResult = null;
      state.activeTab = await getActiveTab();
      state.view = 'programs';
      await persist();
    }
    if (form.id === 'program-form') {
      const values = new FormData(form).getAll('program');
      if (!values.length) throw new Error('Choose at least one application or the current form.');
      if (values.includes('current')) {
        state.activeTab = await getActiveTab();
        await scanTab(state.activeTab);
      }
      await openSelectedPrograms(values);
      state.view = 'dashboard';
      await persist();
    }
    if (form.id === 'questions-form') {
      const application = state.apps.find((item) => item.id === state.currentAppId);
      if (!application) throw new Error('That application is no longer available.');
      const data = new FormData(form);
      const userAssignments = [];
      const unresolved = [];
      (application.analysis?.gaps || []).forEach((gap, index) => {
        const answer = String(data.get(`answer-${index}`) || '').trim();
        if (!answer) {
          unresolved.push(gap);
          return;
        }
        userAssignments.push({
          fieldKey: gap.fieldKey,
          label: gap.label,
          purpose: gap.purpose,
          value: answer,
          source: 'user',
          detail: 'Your answer in this browser session',
          sensitive: gap.sensitive,
        });
      });
      if (application.autoRun) await runThroughApplication(application, userAssignments, unresolved);
      else await fillApplication(application, userAssignments, unresolved);
    }
    render();
  }

  function previewRuntime(message) {
    if (message.type === 'GET_CONNECTOR_STATUS') {
      return Promise.resolve({
        ok: true,
        connector: state.connector || {
          mode: 'demo',
          provider: 'bundled-demo-records',
          organizationName: 'Nava fictional test data',
          status: 'ready',
        },
      });
    }
    if (message.type === 'DISCOVER_CONNECTOR') {
      try {
        const config = connectorEngine.sanitizeConfig(message.config);
        const schema = connectorEngine.normalizeSchemaFields(PREVIEW_CONNECTOR_SCHEMA);
        return Promise.resolve({
          ok: true,
          health: { organizationName: config.organizationName, provider: 'apricot360' },
          config,
          schema,
          suggestions: connectorEngine.suggestMappings(schema, config.mappings),
        });
      } catch (error) {
        return Promise.resolve({ ok: false, error: error.message });
      }
    }
    if (message.type === 'SAVE_CONNECTOR') {
      try {
        const config = connectorEngine.validateMappings(message.config, message.schema);
        state.connector = { ...config, status: 'ready', connectedAt: new Date().toISOString(), schemaFieldCount: message.schema.length };
        return Promise.resolve({ ok: true, connector: state.connector });
      } catch (error) {
        return Promise.resolve({ ok: false, error: error.message });
      }
    }
    if (message.type === 'RESET_CONNECTOR') {
      state.connector = { mode: 'demo', provider: 'bundled-demo-records', organizationName: 'Nava fictional test data', status: 'ready' };
      return Promise.resolve({ ok: true, connector: state.connector });
    }
    if (message.type === 'LOOKUP_RECORD') {
      if (managedConnector()) {
        if (String(message.recordId) !== '339619') return Promise.resolve({ ok: false, record: null, message: 'The preview connector includes record 339619.' });
        try {
          const mapped = connectorEngine.mapRecord(PREVIEW_RAW_RECORD, state.connector, PREVIEW_CONNECTOR_SCHEMA);
          return Promise.resolve({
            ok: mapped.found,
            record: mapped.record,
            provider: 'apricot360',
            connector: { organizationName: state.connector.organizationName, stale: mapped.stale, mappedFields: Object.keys(mapped.provenance).length },
            message: 'Record loaded from the preview connector.',
          });
        } catch (error) {
          return Promise.resolve({ ok: false, record: null, error: error.message });
        }
      }
      const record = DEMO_RECORDS[String(message.recordId)] || null;
      return Promise.resolve({
        ok: Boolean(record),
        record,
        message: record ? 'Demo record loaded.' : 'Preview mode only includes demo ID 339619.',
      });
    }
    if (message.type === 'OPEN_PROGRAMS') {
      const names = { calfresh: 'CalFresh', medical: 'Medi-Cal', wic: 'WIC', calworks: 'CalWORKs', ihss: 'IHSS' };
      return Promise.resolve({
        ok: true,
        opened: message.programs.map((key, index) => ({
          tabId: 8000 + index,
          name: names[key],
          url: key === 'wic'
            ? 'https://www.ruhealth.org/appointments/apply-4-wic-form'
            : key === 'ihss'
              ? 'https://riversideihss.org/IntakeApp'
              : 'https://benefitscal.com/',
        })),
      });
    }
    return Promise.resolve({ ok: true });
  }

  function previewTabMessage(message) {
    const previewResponse = (payload, delay = 0) => demoMode && delay
      ? new Promise((resolve) => setTimeout(() => resolve(payload), delay))
      : Promise.resolve(payload);
    const pages = {
      1: {
        title: 'About the applicant',
        fields: [
          { fieldKey: 'page1:first', type: 'text', label: 'First Name', required: true, autocomplete: 'given-name', value: '' },
          { fieldKey: 'page1:middle', type: 'text', label: 'Middle Name', autocomplete: 'additional-name', value: '' },
          { fieldKey: 'page1:last', type: 'text', label: 'Last Name', required: true, autocomplete: 'family-name', value: '' },
          { fieldKey: 'page1:dob', type: 'text', label: 'Date of Birth', required: true, id: 'birthDate', maxLength: 10, value: '' },
        ],
        gate: { kind: 'next', text: 'Next', pageSignature: 'preview:page-1', reason: 'A known safe “Next” control is ready.' },
      },
      2: {
        title: 'Home address',
        fields: [
          { fieldKey: 'page2:street', type: 'text', label: 'Street address', required: true, autocomplete: 'address-line1', value: '' },
          { fieldKey: 'page2:unit', type: 'text', label: 'Apartment or unit', autocomplete: 'address-line2', value: '' },
          { fieldKey: 'page2:city', type: 'text', label: 'City', required: true, autocomplete: 'address-level2', value: '' },
          { fieldKey: 'page2:state', type: 'text', label: 'State', required: true, autocomplete: 'address-level1', value: '' },
          { fieldKey: 'page2:zip', type: 'text', label: 'ZIP code', required: true, autocomplete: 'postal-code', maxLength: 5, value: '' },
        ],
        gate: { kind: 'next', text: 'Save and continue', pageSignature: 'preview:page-2', reason: 'A known safe “Save and continue” control is ready.' },
      },
      3: {
        title: 'Contact and final review',
        fields: [
          { fieldKey: 'page3:email', type: 'email', label: 'Email', required: true, autocomplete: 'email', value: '' },
          { fieldKey: 'page3:phone', type: 'tel', label: 'Mobile Phone', required: true, autocomplete: 'tel', maxLength: 10, value: '' },
          { fieldKey: 'page3:language', type: 'text', label: 'Primary language', autocomplete: 'language', value: '' },
        ],
        gate: { kind: 'final_review', text: 'Submit application', pageSignature: 'preview:page-3', reason: 'The application reached its final review step. Submission stays with the caseworker.' },
      },
    };
    const page = pages[state.previewPage] || pages[3];
    if (message.type === 'NAVA_SCAN') {
      return previewResponse({
        ok: true,
        page: { title: page.title, url: `https://benefitscal.com/ApplyForBenefits/step-${state.previewPage}`, domain: 'benefitscal.com' },
        playbook: { status: 'fresh', name: 'California benefits application', note: 'Bundled BenefitsCal playbook; automatic continuation is limited to exact Begin, Next, and Continue controls.' },
        analysis: engine.buildAnalysis(page.fields, message.participant),
        submitGate: { found: false, enabled: false, botCheckPresent: false, blockedReason: '' },
        navigationGate: page.gate,
      }, 240);
    }
    if (message.type === 'NAVA_FILL') {
      const results = message.assignments.map((item) => ({ ...item, status: 'verified', actual: item.value, reason: '' }));
      return previewResponse({
        ok: true,
        results,
        provenance: results.map((item) => ({ ...item, value: item.sensitive ? '••••' : item.actual })),
        submitGate: state.previewPage === 3
          ? { found: true, enabled: true, botCheckPresent: false, blockedReason: 'The assistant never activates Submit application.' }
          : { found: false, enabled: false, botCheckPresent: false, blockedReason: '' },
        navigationGate: page.gate,
      }, 650);
    }
    if (message.type === 'NAVA_NAVIGATION_STATUS') {
      return previewResponse({ ok: true, navigationGate: page.gate }, 180);
    }
    if (message.type === 'NAVA_ADVANCE') {
      if (page.gate.kind !== 'next') return previewResponse({ ok: true, advanced: false, navigationGate: page.gate });
      state.previewPage = Math.min(3, state.previewPage + 1);
      return previewResponse({ ok: true, advanced: true, navigationGate: page.gate }, 900);
    }
    return previewResponse({ ok: true });
  }

  async function loadPreviewDocumentFixture() {
    if (!previewMode) return false;
    const params = new URLSearchParams(location.search);
    const fixtureKey = params.get('fixture');
    const fixtures = {
      pdf: { name: 'sample-client.pdf', type: 'application/pdf' },
      docx: { name: 'sample-business.docx', type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
      csv: { name: 'sample-business.csv', type: 'text/csv' },
    };
    const fixture = fixtures[fixtureKey];
    if (!fixture) return false;
    const response = await fetch(`../demo/fixtures/${fixture.name}`);
    if (!response.ok) throw new Error('The local preview document could not be loaded.');
    const file = new File([await response.arrayBuffer()], fixture.name, { type: fixture.type });
    state.documentResult = await globalThis.NavaDocumentParser.parseDocument(file);
    if (params.get('conflict') === '1') state.participant = DEMO_RECORDS['339619'];
    state.view = 'document-review';
    return true;
  }

  appRoot.addEventListener('click', (event) => {
    const button = event.target.closest('[data-action]');
    if (!button) return;
    onClick(button).catch((error) => {
      state.error = error.message;
      render();
    });
  });

  appRoot.addEventListener('submit', (event) => {
    event.preventDefault();
    onSubmit(event.target).catch((error) => {
      state.error = error.message;
      render();
    });
  });

  async function bootstrap() {
    setBusy('Opening the assistant…');
    try {
      await restoreConnector();
      await restore();
      state.activeTab = await getActiveTab();
      await loadPreviewDocumentFixture();
      render();
    } catch (error) {
      state.error = error.message;
      state.view = 'choice';
      render();
    }
  }

  bootstrap();
})();
