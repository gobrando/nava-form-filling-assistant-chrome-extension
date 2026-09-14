(function startSidePanel() {
  'use strict';

  const appRoot = document.getElementById('app');
  const engine = globalThis.NavaFormEngine;
  const previewMode = new URLSearchParams(location.search).get('preview') === '1'
    || !globalThis.chrome?.runtime?.id;

  const state = {
    view: 'choice',
    error: '',
    participant: null,
    documentResult: null,
    activeTab: null,
    apps: [],
    currentAppId: null,
  };

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

  function clientSummary() {
    return engine.canonicalizeParticipant(state.participant || {});
  }

  function firstName() {
    return clientSummary().values.firstName || clientSummary().name || 'Client';
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
      return { id: 7001, title: 'Benefits application', url: 'https://benefitscal.com/ApplyForBenefits/ABNMI' };
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
        <div class="notice" style="margin-top:16px"><span aria-hidden="true">i</span><span>The source app currently uses bundled demo records, not a live Apricot connection. This extension keeps that boundary explicit.</span></div>
      </section>`;
  }

  function renderRecordId() {
    appRoot.innerHTML = `
      <section>
        <button class="back-button" type="button" data-action="back-choice"><span aria-hidden="true">←</span> Back</button>
        <div class="intro">
          <p class="eyebrow">Client record</p>
          <h1>Let's find your client</h1>
          <p class="lede">Enter an Apricot 360 ID. We'll pull the record through the configured data provider.</p>
        </div>
        ${renderError()}
        <form id="record-form" class="stack">
          <div class="field">
            <label for="record-id">Apricot 360 ID</label>
            <input id="record-id" name="recordId" type="text" inputmode="numeric" autocomplete="off" placeholder="Enter ID" required>
            <p class="field-hint">Prototype demo IDs: 339619, 338618, and 339637.</p>
          </div>
          <div class="form-actions">
            <button class="primary-button" type="submit">Continue</button>
            <button class="secondary-button" type="button" data-action="choose-json">Paste client JSON instead</button>
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
          <div><strong>${escapeHtml(client.name)}</strong><span>${client.recordId ? `Record ${escapeHtml(client.recordId)}` : state.participant?._documentSources?.length ? 'Document import' : 'Pasted client record'}</span></div>
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
    const note = application.error
      || (blocked ? `${blocked} fields need direct help` : '')
      || (gaps ? `${gaps} answers are needed before this page is complete` : '')
      || (review ? 'All writes on this page were read back and verified' : 'Ready to fill the values found in the client record');
    let actions = '';
    if (attention && gaps) {
      actions = `<button class="small-button" type="button" data-action="answer" data-app="${encoded(application.id)}">Answer questions</button>`;
    } else if (application.status === 'ready_to_fill') {
      actions = `<button class="small-button" type="button" data-action="fill" data-app="${encoded(application.id)}">Fill available fields</button>`;
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
          <p class="lede">Each application has one tab and one writer. Nothing is submitted from this assistant.</p>
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
          <p class="lede">Your answers go directly into the application. Leave a field blank if you do not know it—the assistant will not guess.</p>
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
            <button class="primary-button" type="submit">Fill the page</button>
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
    const rows = [
      ...(application.provenance || []),
      ...(application.empty || []).map((item) => ({ label: item.label, value: '(empty)', source: 'empty', detail: item.reason || 'No value was provided' })),
    ];
    const verified = (application.provenance || []).length;
    const empty = (application.empty || []).length;
    const unused = application.analysis?.noFields?.length || 0;
    const gate = application.submitGate || {};
    appRoot.innerHTML = `
      <section>
        <button class="back-button" type="button" data-action="back-dashboard"><span aria-hidden="true">←</span> Back</button>
        <div class="intro">
          <p class="eyebrow">${escapeHtml(application.name)}</p>
          <h1>Review what was filled</h1>
          <p class="lede">Every changed value below was read back from the form. Review the application itself before you submit it.</p>
        </div>
        <div class="summary-grid">
          <div class="summary-card"><strong>${verified}</strong><span>Verified</span></div>
          <div class="summary-card"><strong>${empty}</strong><span>Empty</span></div>
          <div class="summary-card"><strong>${unused}</strong><span>No place</span></div>
        </div>
        <div class="table-wrap">
          <table class="review-table">
            <thead><tr><th style="width:34%">Field</th><th style="width:36%">Value</th><th style="width:30%">Source</th></tr></thead>
            <tbody>${rows.map((row) => `
              <tr>
                <td>${escapeHtml(row.label)}</td>
                <td title="${escapeHtml(row.detail || '')}">${escapeHtml(row.value)}</td>
                <td><span class="source-chip ${escapeHtml(row.source)}">${escapeHtml(sourceLabel(row.source))}</span></td>
              </tr>`).join('')}</tbody>
          </table>
        </div>
        ${application.analysis?.noFields?.length ? `
          <p class="section-label">Values with no field on this page</p>
          <p class="card-note">${application.analysis.noFields.map((item) => escapeHtml(item.label)).join(', ')}</p>` : ''}
        <div class="notice warning" style="margin-top:18px"><span aria-hidden="true">!</span><span>${escapeHtml(gate.blockedReason || 'The assistant will not submit this application. Review the page, complete any affirmation or bot check, and submit it yourself.')}</span></div>
        <div class="form-actions">
          <button class="primary-button" type="button" data-action="go-tab" data-app="${encoded(application.id)}">Go to application</button>
          <button class="secondary-button" type="button" data-action="rescan" data-app="${encoded(application.id)}">Scan this page again</button>
        </div>
      </section>`;
  }

  function render() {
    if (state.view === 'record') return renderRecordId();
    if (state.view === 'json') return renderJsonImport();
    if (state.view === 'document') return renderDocumentUpload();
    if (state.view === 'document-review') return renderDocumentReview();
    if (state.view === 'programs') return renderPrograms();
    if (state.view === 'dashboard') return renderDashboard();
    if (state.view === 'questions') return renderQuestions();
    if (state.view === 'review') return renderReview();
    return renderChoice();
  }

  async function lookupRecord(recordId) {
    setBusy('Finding the client record…');
    const response = await sendRuntime({ type: 'LOOKUP_RECORD', recordId });
    if (!response?.ok || !response.record) throw new Error(response?.message || 'No client record was found.');
    state.participant = response.record;
    state.activeTab = await getActiveTab();
    state.view = 'programs';
    await persist();
  }

  async function scanTab(tab) {
    setBusy('Checking this form and its required fields…');
    const response = await sendToTab(tab, { type: 'NAVA_SCAN', participant: state.participant });
    if (!response?.ok) throw new Error(response?.error || 'The form could not be read.');
    const id = `tab:${tab.id}`;
    const fieldsFound = response.analysis?.counts?.fields || 0;
    const application = {
      id,
      tabId: tab.id,
      name: response.playbook?.name || response.page?.title || hostLabel(tab.url),
      url: response.page?.url || tab.url,
      status: fieldsFound === 0
        ? 'no_form'
        : response.analysis.gaps.length
          ? 'needs_attention'
          : 'ready_to_fill',
      analysis: response.analysis,
      playbook: response.playbook,
      submitGate: response.submitGate,
      error: fieldsFound === 0 ? 'No visible application fields were found on this page.' : '',
      provenance: [],
      blocked: [],
      empty: [],
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

  async function fillApplication(application, userAssignments = [], unresolved = []) {
    const tab = previewMode
      ? { id: application.tabId, url: application.url }
      : await chrome.tabs.get(application.tabId);
    setBusy('Filling the page and checking every value…');
    const previousProvenance = application.provenance || [];
    const verifiedKeys = new Set(previousProvenance.map((item) => item.fieldKey));
    const assignments = [...(application.analysis?.assignments || []), ...userAssignments]
      .filter((item) => !verifiedKeys.has(item.fieldKey));
    const response = await sendToTab(tab, { type: 'NAVA_FILL', assignments });
    if (!response?.ok) throw new Error(response?.error || 'The page could not be filled.');
    const provenanceByField = new Map();
    [...previousProvenance, ...(application.analysis?.observed || []), ...(response.provenance || [])]
      .forEach((item) => provenanceByField.set(item.fieldKey, item));
    application.provenance = [...provenanceByField.values()];
    application.blocked = (response.results || []).filter((item) => item.status !== 'verified');
    application.empty = [
      ...unresolved.map((gap) => ({ label: gap.label, reason: 'No answer was provided.' })),
      ...application.blocked.map((item) => ({ label: item.label, reason: item.reason })),
    ];
    application.submitGate = response.submitGate || application.submitGate;
    application.analysis.gaps = unresolved;
    application.status = application.empty.length ? 'needs_attention' : 'ready_for_review';
    application.updatedAt = new Date().toISOString();
    state.currentAppId = application.id;
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
    if (action === 'choose-document') {
      state.documentResult = null;
      state.view = 'document';
    }
    if (action === 'back-choice') state.view = 'choice';
    if (action === 'back-programs') state.view = 'programs';
    if (action === 'back-document') {
      state.documentResult = null;
      state.view = 'document';
    }
    if (action === 'change-client') {
      state.participant = null;
      state.documentResult = null;
      state.apps = [];
      state.currentAppId = null;
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
      state.apps = [];
      state.currentAppId = null;
      state.view = 'choice';
      if (!previewMode) await chrome.storage.session.remove('nava:session');
    }
    if (['answer', 'fill', 'review', 'rescan', 'go-tab'].includes(action)) {
      const id = decoded(button.dataset.app);
      const application = state.apps.find((item) => item.id === id);
      if (!application) throw new Error('That application is no longer available.');
      state.currentAppId = id;
      if (action === 'answer') state.view = 'questions';
      if (action === 'fill') await fillApplication(application);
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
      await fillApplication(application, userAssignments, unresolved);
    }
    render();
  }

  function previewRuntime(message) {
    if (message.type === 'LOOKUP_RECORD') {
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
    if (message.type === 'NAVA_SCAN') {
      const fields = [
        { fieldKey: 'first', type: 'text', label: 'First Name (required)', required: true, autocomplete: 'given-name', value: '' },
        { fieldKey: 'last', type: 'text', label: 'Last Name (required)', required: true, autocomplete: 'family-name', value: '' },
        { fieldKey: 'dob', type: 'text', label: 'Date of Birth', required: true, id: 'birthDate', maxLength: 10, value: '' },
        { fieldKey: 'email', type: 'email', label: 'Email', required: true, autocomplete: 'email', value: '' },
        { fieldKey: 'phone', type: 'tel', label: 'Mobile Phone', required: true, autocomplete: 'tel', maxLength: 10, value: '' },
        { fieldKey: 'housing:yes', groupKey: 'housing', type: 'radio', label: 'Yes', optionLabel: 'Yes', question: 'Is the client experiencing homelessness?', value: 'yes', required: true },
        { fieldKey: 'housing:no', groupKey: 'housing', type: 'radio', label: 'No', optionLabel: 'No', question: 'Is the client experiencing homelessness?', value: 'no', required: true },
        { fieldKey: 'immigration', type: 'text', label: "What is the client's immigration status?", required: true, value: '' },
        { fieldKey: 'childcare:yes', groupKey: 'childcare', type: 'radio', label: 'Yes', optionLabel: 'Yes', question: 'Is the client currently paying for childcare?', value: 'yes' },
        { fieldKey: 'childcare:no', groupKey: 'childcare', type: 'radio', label: 'No', optionLabel: 'No', question: 'Is the client currently paying for childcare?', value: 'no' },
        { fieldKey: 'income', type: 'text', label: 'Monthly household income', required: true, value: '' },
      ];
      return Promise.resolve({
        ok: true,
        page: { title: 'Benefits application', url: 'https://benefitscal.com/ApplyForBenefits/ABNMI', domain: 'benefitscal.com' },
        playbook: { status: 'fresh', name: 'CalFresh', note: 'Bundled BenefitsCal playbook. A known field was found on this page.' },
        analysis: engine.buildAnalysis(fields, message.participant),
        submitGate: { found: false, enabled: false, botCheckPresent: false, blockedReason: '' },
      });
    }
    if (message.type === 'NAVA_FILL') {
      const results = message.assignments.map((item) => ({ ...item, status: 'verified', actual: item.value, reason: '' }));
      return Promise.resolve({
        ok: true,
        results,
        provenance: results.map((item) => ({ ...item, value: item.sensitive ? '••••' : item.actual })),
        submitGate: { found: true, enabled: false, botCheckPresent: true, botCheckComplete: false, blockedReason: 'A human must complete the bot check before submission.' },
      });
    }
    return Promise.resolve({ ok: true });
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
