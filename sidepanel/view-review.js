// Per-application caseworker screens: the missing-question form and the read-back review of every filled value before the human submits.
(function installReviewViews(root) {
  'use strict';

  /**
   * deps:
   * - state, appRoot: panel state and the screen root.
   * - format: NavaPanelFormat helpers.
   * - renderError(): shared panel helper; renderDashboard(): shown when the application is gone.
   */
  function create(deps) {
    const {
      state,
      appRoot,
      format,
      renderError,
      renderDashboard,
    } = deps;
    const { escapeHtml, encoded, sourceLabel } = format;

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
                  ${gap.inputType === 'multi_choice' && options.length ? `
                    <div class="choice-grid">
                      ${options.map((option) => `
                        <label class="choice-pill">
                          <input type="checkbox" name="${name}" value="${escapeHtml(option.value)}">
                          <span>${escapeHtml(option.label)}</span>
                        </label>`).join('')}
                      <label class="choice-pill">
                        <input type="checkbox" name="${name}" value="__none__">
                        <span>None of these</span>
                      </label>
                    </div>` : gap.inputType === 'choice' && options.length ? `
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
            <button class="secondary-button" type="button" data-action="client-link">Send these questions to the client</button>
          </div>
          ${renderError()}
          ${application.clientLink ? `<div class="notice"><span aria-hidden="true">i</span><span>Client link, valid until it expires: ${escapeHtml(application.clientLink)}</span></div>` : ''}
        </form>
      </section>`;
    }

    /** Every completed page plus the page the application is on now. */
    function reviewPages(application) {
      return [
        ...(application.completedPages || []),
        { title: application.page?.title || application.name, provenance: application.provenance || [], empty: application.empty || [], noFields: application.analysis?.noFields || [] },
      ];
    }

    /** One row per read-back value and per field left empty, tagged with the page it came from. */
    function reviewRows(pageSnapshots) {
      return pageSnapshots.flatMap((page) => [
        ...(page.provenance || []).map((item) => ({ ...item, pageTitle: page.title })),
        ...(page.empty || []).map((item) => ({ label: item.label, value: '(empty)', source: 'empty', detail: item.reason || 'No value was provided', pageTitle: page.title })),
      ]);
    }

    function reviewRow(row) {
      return `
              <tr>
                <td><span class="review-page">${escapeHtml(row.pageTitle || '')}</span>${escapeHtml(row.label)}</td>
                <td title="${escapeHtml(row.detail || '')}">${escapeHtml(row.value)}</td>
                <td><span class="source-chip ${escapeHtml(row.source)}">${escapeHtml(sourceLabel(row.source))}</span></td>
              </tr>`;
    }

    function reviewSummary(pageSnapshots) {
      const verified = pageSnapshots.reduce((sum, page) => sum + (page.provenance?.length || 0), 0);
      const empty = pageSnapshots.reduce((sum, page) => sum + (page.empty?.length || 0), 0);
      return `<div class="summary-grid">
          <div class="summary-card"><strong>${verified}</strong><span>Verified</span></div>
          <div class="summary-card"><strong>${empty}</strong><span>Empty</span></div>
          <div class="summary-card"><strong>${pageSnapshots.length}</strong><span>Pages</span></div>
        </div>`;
    }

    /** Client values that no page in this flow had a field for. */
    function unmatchedClientFields(pageSnapshots) {
      const noFieldLists = pageSnapshots.map((page) => page.noFields || []);
      return (noFieldLists[0] || []).filter((candidate) =>
        noFieldLists.every((items) => items.some((item) => item.purpose === candidate.purpose)));
    }

    /** Why the run stopped; without a recorded reason, the standing notice that submission stays with the caseworker. */
    function reviewStopReason(application) {
      const gate = application.submitGate || {};
      return application.runStopReason || application.navigationGate?.reason || gate.blockedReason
        || 'The assistant will not submit this application. Review the page, complete any affirmation or bot check, and submit it yourself.';
    }

    function renderReview() {
      const application = state.apps.find((item) => item.id === state.currentAppId);
      if (!application) {
        state.view = 'dashboard';
        return renderDashboard();
      }
      const completedPages = application.completedPages || [];
      const pageSnapshots = reviewPages(application);
      const unusedEntries = unmatchedClientFields(pageSnapshots);
      const unused = unusedEntries.length;
      appRoot.innerHTML = `
      <section>
        <button class="back-button" type="button" data-action="back-dashboard"><span aria-hidden="true">←</span> Back</button>
        <div class="intro">
          <p class="eyebrow">${escapeHtml(application.name)}</p>
          <h1>Review what was filled</h1>
          <p class="lede">Every changed value below was read back from the form. The assistant stopped before the final action so a caseworker can review and submit.</p>
        </div>
        ${reviewSummary(pageSnapshots)}
        ${completedPages.length ? `<ol class="page-progress-list">${pageSnapshots.map((page, index) => `<li><span>Page ${index + 1}</span><strong>${escapeHtml(page.title || 'Application page')}</strong></li>`).join('')}</ol>` : ''}
        <div class="table-wrap">
          <table class="review-table">
            <thead><tr><th style="width:34%">Field</th><th style="width:36%">Value</th><th style="width:30%">Source</th></tr></thead>
            <tbody>${reviewRows(pageSnapshots).map(reviewRow).join('')}</tbody>
          </table>
        </div>
        ${unused ? `<p class="card-note" style="margin-top:12px">No matching field in this flow: ${unusedEntries.map((item) => escapeHtml(item.label)).join(', ')}.</p>` : ''}
        <div class="notice warning" style="margin-top:18px"><span aria-hidden="true">!</span><span>${escapeHtml(reviewStopReason(application))}</span></div>
        <div class="form-actions">
          <button class="primary-button" type="button" data-action="go-tab" data-app="${encoded(application.id)}">Go to application</button>
          <button class="secondary-button" type="button" data-action="rescan" data-app="${encoded(application.id)}">Scan this page again</button>
        </div>
      </section>`;
    }

    return { choiceOptions, renderQuestions, renderReview };
  }

  const api = { create };

  root.NavaReviewViews = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
