// Client-intake screens: the start choice, model-runtime notice and settings, record ID, JSON import, document upload and review, and the program picker.
(function installIntakeViews(root) {
  'use strict';

  /**
   * deps:
   * - state, appRoot, previewMode: panel state, the screen root, and simulated-preview flag.
   * - format: NavaPanelFormat helpers.
   * - engine: the form engine (value normalization); agentPlanner: the model runtime; programCatalog: known sites.
   * - renderError(), clientSummary(), managedConnector(): shared panel helpers.
   * - renderConnectorStatus(), connectorTitle(), connectorProvider(), connectorSourceId(): connector view helpers.
   */
  function create(deps) {
    const {
      state,
      appRoot,
      previewMode,
      format,
      engine,
      agentPlanner,
      programCatalog,
      renderError,
      clientSummary,
      managedConnector,
      renderConnectorStatus,
      connectorTitle,
      connectorProvider,
      connectorSourceId,
    } = deps;
    const { escapeHtml, displayValue, formatTimestamp, hostLabel } = format;

    function sameValue(left, right) {
      return engine.normalize(left) === engine.normalize(right);
    }

    function agentRuntimeTitle(info, ready, unavailable) {
      return ready ? `${info.title} ready` : unavailable ? `${info.title} unavailable` : 'Agentic AI required';
    }

    function agentRuntimeDetail(info, ready, unavailable, companion) {
      if (ready) {
        return state.agentRuntime.shared
          ? 'Field mapping and missing-field decisions run on the shared Nava API. Jev handles the confident ones when the API has a TypeSafe key. Filling still happens in this tab, and client values stay out of the planning prompt.'
          : `${info.detail} The field mapper, gap analyst, and independent reviewer remain separate model calls.`;
      }
      if (unavailable) {
        return state.agentRuntime.message || (companion
          ? 'Start the localhost companion and sign the selected CLI in with its subscription account.'
          : 'This device cannot start Chrome built-in AI. Use Chrome 138 or newer on a supported desktop and enable built-in AI.');
      }
      return `${companion ? 'Connect the paired localhost companion' : 'Start Chrome’s on-device model'} before a live form run. Client values are never included in model prompts.`;
    }

    function modelRuntimeSettings(selectedProvider, companion) {
      return `<details class="model-runtime-settings" style="margin-bottom:16px">
        <summary>Model runtime</summary>
        <form id="model-provider-form" class="form-stack compact-form">
          <label for="model-provider">Brain
            <select id="model-provider" name="modelProvider">
              <option value="chrome-local" ${selectedProvider === 'chrome-local' ? 'selected' : ''}>Chrome on-device Gemini Nano</option>
              <option value="codex" ${selectedProvider === 'codex' ? 'selected' : ''}>Codex subscription via local CLI</option>
              <option value="claude" ${selectedProvider === 'claude' ? 'selected' : ''}>Claude subscription via local CLI</option>
            </select>
          </label>
          <div id="model-companion-fields" class="form-stack compact-form" ${companion ? '' : 'hidden'}>
            <label for="model-endpoint">Local companion
              <input id="model-endpoint" name="modelEndpoint" type="text" value="${escapeHtml(state.agentProvider.endpoint || 'http://127.0.0.1:4174')}" autocomplete="off" spellcheck="false">
            </label>
            <label for="model-token">Pairing token
              <input id="model-token" name="modelToken" type="password" value="${escapeHtml(state.agentProvider.token || '')}" autocomplete="off">
            </label>
            <p class="field-hint">Run <code>npm run model:bridge</code> in this repository, then paste its token. Provider credentials never enter Chrome.</p>
          </div>
          <button class="small-button secondary" type="submit">Use this model runtime</button>
        </form>
      </details>`;
    }

    function renderAgentRuntime() {
      if (previewMode) {
        return '<div class="notice"><span aria-hidden="true">AI</span><span><strong>Fixture preview.</strong> Install the extension to run the on-device multi-agent planner.</span></div>';
      }
      const ready = state.agentRuntime.status === 'ready';
      const unavailable = state.agentRuntime.status === 'unavailable';
      const info = agentPlanner?.runtimeInfo?.() || { kind: 'chrome-local', title: 'Chrome on-device AI', detail: '' };
      const selectedProvider = state.agentProvider.kind === 'local-cli' ? state.agentProvider.provider : 'chrome-local';
      const companion = state.agentProvider.kind === 'local-cli';
      const title = agentRuntimeTitle(info, ready, unavailable);
      const detail = agentRuntimeDetail(info, ready, unavailable, companion);
      return `
      <div class="notice ${unavailable ? 'error' : ''}" style="margin-bottom:16px">
        <span aria-hidden="true">AI</span>
        <span><strong>${escapeHtml(title)}.</strong> ${escapeHtml(detail)}</span>
      </div>
      ${ready ? '' : '<button class="secondary-button" style="margin-bottom:12px" type="button" data-action="enable-agent">Enable agentic AI</button>'}
      ${modelRuntimeSettings(selectedProvider, companion)}`;
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
        ${renderAgentRuntime()}
        <button class="recertification-entry" type="button" data-action="open-recertifications">
          <span class="choice-icon" aria-hidden="true">↻</span>
          <span class="choice-copy"><strong>Recertification status</strong><small>See upcoming renewals across the caseload, gather updates, and request client authorization.</small></span>
          <span class="chevron" aria-hidden="true">›</span>
        </button>
        ${renderConnectorStatus()}
        <div class="stack">
          <button class="choice-button" type="button" data-action="choose-id">
            <span class="choice-icon" aria-hidden="true">ID</span>
            <span class="choice-copy"><strong>I have their client record ID</strong><small>Use the connected organization data source.</small></span>
            <span class="chevron" aria-hidden="true">›</span>
          </button>
          <button class="choice-button" type="button" data-action="choose-json">
            <span class="choice-icon" aria-hidden="true">{ }</span>
            <span class="choice-copy"><strong>I don't have their record ID</strong><small>Paste the client information as JSON.</small></span>
            <span class="chevron" aria-hidden="true">›</span>
          </button>
          <button class="choice-button" type="button" data-action="choose-document">
            <span class="choice-icon" aria-hidden="true">DOC</span>
            <span class="choice-copy"><strong>Upload a client or business document</strong><small>Review labeled details from scans, images, PDF, Word, text, CSV, or JSON.</small></span>
            <span class="chevron" aria-hidden="true">›</span>
          </button>
        </div>
        <div class="notice" style="margin-top:16px"><span aria-hidden="true">i</span><span>${managedConnector() ? 'Record lookup uses the organization’s read-only connector. Credentials remain in the Nava connector service, never in Chrome.' : 'No production database is connected. All bundled records are fictional.'}</span></div>
        ${renderPlannerSettings()}
      </section>`;
    }

    function renderPlannerSettings() {
      if (previewMode) return '';
      const configured = Boolean(state.plannerBase);
      return `
      <form id="planner-form" class="stack" style="margin-top:16px">
        <div class="field">
          <label for="nava-api-base">Shared planner API</label>
          <input id="nava-api-base" name="navaApiBase" type="url" inputmode="url" autocomplete="off" placeholder="https://api.example.com" value="${escapeHtml(state.plannerBase || '')}">
          <p class="field-hint">${configured ? 'A tenant key is already saved on this device. Paste a new one only to replace it.' : 'Paste the API address and a tenant key so planning uses the same engine as the Nava API. The key stays in this browser.'}</p>
        </div>
        <div class="field">
          <label for="nava-api-token">Tenant API key</label>
          <input id="nava-api-token" name="navaApiToken" type="password" autocomplete="off" placeholder="${configured ? 'Saved' : 'nava_…'}">
        </div>
        <button class="secondary-button" type="button" data-action="save-planner">Use the shared planner</button>
      </form>`;
    }

    function renderRecordId() {
      const provider = connectorProvider();
      appRoot.innerHTML = `
      <section>
        <button class="back-button" type="button" data-action="back-choice"><span aria-hidden="true">←</span> Back</button>
        <div class="intro">
          <p class="eyebrow">Client record</p>
          <h1>Let's find your client</h1>
          <p class="lede">Enter the client record ID. We'll pull the record through ${escapeHtml(connectorTitle())}.</p>
        </div>
        ${renderError()}
        <form id="record-form" class="stack">
          <div class="field">
            <label for="record-id">${managedConnector() ? escapeHtml(provider.recordLabel) : 'Fictional demo record ID'}</label>
            <input id="record-id" name="recordId" type="text" autocomplete="off" placeholder="Enter ID" required>
            <p class="field-hint">${managedConnector() ? `Read-only ${escapeHtml(provider.name)} connector · source ${escapeHtml(connectorSourceId())} · ${Object.keys(state.connector.mappings || {}).length} mapped fields` : 'Prototype demo IDs: 339619, 338618, and 339637.'}</p>
          </div>
          <div class="form-actions">
            <button class="primary-button" type="submit">Continue</button>
            <button class="secondary-button" type="button" data-action="choose-json">Paste client JSON instead</button>
            <button class="link-button" type="button" data-action="configure-connector">Manage data source</button>
          </div>
        </form>
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
            <span>PDF, PNG, JPEG, WebP, DOCX, TXT, CSV, TSV, or JSON · up to 15 MB</span>
            <input id="client-document" name="clientDocument" type="file" accept=".pdf,.png,.jpg,.jpeg,.webp,.docx,.txt,.csv,.tsv,.json,application/pdf,image/png,image/jpeg,image/webp,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain,text/csv,application/json" required>
          </label>
          <div class="notice"><span aria-hidden="true">⌁</span><span>The raw file stays on this device and is discarded after parsing. Image-only pages use the bundled English OCR model with strict page, pixel, attempt, and time limits.</span></div>
          <div class="form-actions">
            <button class="primary-button" type="submit">Read document</button>
            ${state.participant ? '' : '<button class="secondary-button" type="button" data-action="choose-json">Paste JSON instead</button>'}
          </div>
        </form>
      </section>`;
    }

    /** Page, region, and rotation evidence for a value read by on-device OCR; empty for other extraction methods. */
    function ocrProvenance(field) {
      if (field.source?.method !== 'ocr') return '';
      return `<span class="ocr-provenance">Page ${escapeHtml(field.source.pageNumber)}${field.source.region ? ` · region ${escapeHtml(Math.round(field.source.region.x0))},${escapeHtml(Math.round(field.source.region.y0))}–${escapeHtml(Math.round(field.source.region.x1))},${escapeHtml(Math.round(field.source.region.y1))}` : ''}${field.source.canvas?.rotation ? ` · corrected ${escapeHtml(field.source.canvas.rotation)}° rotation` : ''}</span>`;
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
      const lowConfidenceCount = result.fields.filter((field) => field.confidence === 'low').length;
      const methodLabel = {
        ocr: 'On-device OCR',
        mixed: 'Embedded text + OCR',
        'embedded-text': 'Embedded PDF text',
        docx: 'Word document text',
        text: 'Plain text',
        'delimited-text': 'Delimited text',
        structured: 'Structured JSON',
      }[result.quality?.method] || 'Local extraction';
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
          <span><strong>${escapeHtml(result.file.name)}</strong><small>${escapeHtml(methodLabel)} · ${result.fields.length} proposed ${result.fields.length === 1 ? 'field' : 'fields'}${conflictCount ? ` · ${conflictCount} ${conflictCount === 1 ? 'conflict' : 'conflicts'}` : ''}${lowConfidenceCount ? ` · ${lowConfidenceCount} low confidence` : ''}</small></span>
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
                  <label class="extraction-card ${conflict ? 'conflict' : ''} ${field.confidence === 'low' ? 'low-confidence' : ''}">
                    <input type="checkbox" name="fieldIndex" value="${index}" ${conflict || field.confidence === 'low' || field.reviewRequired ? '' : 'checked'}>
                    <span class="extraction-copy">
                      <span class="extraction-heading"><strong>${escapeHtml(field.label)}</strong><span class="confidence-chip ${escapeHtml(field.confidence)}">${escapeHtml(field.confidence)}</span></span>
                      <span class="extracted-value">${escapeHtml(field.displayValue)}</span>
                      <small>${escapeHtml(field.evidence)}</small>
                      ${ocrProvenance(field)}
                      ${field.reviewRequired ? '<span class="conflict-note"><strong>OCR review required:</strong> verify this value in the source before selecting it.</span>' : field.confidence === 'low' ? '<span class="conflict-note"><strong>Low confidence:</strong> verify this value in the source before selecting it.</span>' : ''}
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
        ${renderAgentRuntime()}
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
              <input type="checkbox" name="program" value="current" ${currentAllowed ? '' : 'disabled'}>
              <span><strong>Analyze this form</strong><small>${escapeHtml(currentAllowed ? hostLabel(tabUrl) : 'Open a website first')}</small></span>
            </label>
          </div>
          <p class="section-label">Known application sites</p>
          <div class="program-list">
            ${programCatalog.PROGRAMS.map((program) => `
              <label class="program-option">
                <input type="checkbox" name="program" value="${escapeHtml(program.id)}">
                <span><strong>${escapeHtml(program.name)}</strong><small>${escapeHtml(program.provider)}${program.workflowId === 'benefitscal' ? ' · combined BenefitsCal application' : ''}</small></span>
              </label>`).join('')}
          </div>
          <div class="notice" style="margin-top:14px"><span aria-hidden="true">i</span><span>CalFresh, Medi-Cal, and CalWORKs share one BenefitsCal application. Selecting more than one opens one tab and carries all selected program names in the same workflow.</span></div>
          <div class="form-actions">
            <button class="primary-button" type="submit">Continue</button>
          </div>
        </form>
      </section>`;
    }

    return {
      renderAgentRuntime,
      renderChoice,
      renderRecordId,
      renderJsonImport,
      renderDocumentUpload,
      renderDocumentReview,
      renderPrograms,
    };
  }

  const api = { create };

  root.NavaIntakeViews = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
