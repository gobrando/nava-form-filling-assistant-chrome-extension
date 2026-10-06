// Recertification screens: the caseload card, the upcoming-renewals list, and the per-client data check and authorization detail.
(function installRecertificationViews(root) {
  'use strict';

  /**
   * deps:
   * - state, appRoot: panel state and the screen root.
   * - format: NavaPanelFormat helpers; recertificationEngine: due dates, summaries, and notification drafts.
   * - renderError(), recertificationById(): shared panel helpers.
   */
  function create(deps) {
    const {
      state,
      appRoot,
      format,
      recertificationEngine,
      renderError,
      recertificationById,
    } = deps;
    const { escapeHtml, encoded } = format;

    function recertificationCard(item) {
      const open = item.openRequirements.length;
      const readiness = item.readyToPrepare
        ? 'Authorized and ready for AI preparation'
        : open
          ? `${open} information area${open === 1 ? '' : 's'} need follow-up`
          : item.consent.status === 'declined'
            ? 'Client declined AI preparation'
            : 'Ready to ask for client authorization';
      return `
      <article class="recert-card ${escapeHtml(item.urgency.key)}">
        <div class="recert-card-top">
          <div><strong>${escapeHtml(item.displayName)}</strong><p class="card-note">${escapeHtml(item.programName)} · due ${escapeHtml(recertificationEngine.dueDateLabel(item.dueDate))}</p></div>
          <span class="urgency-chip ${escapeHtml(item.urgency.key)}">${escapeHtml(item.urgency.label)}</span>
        </div>
        <p class="card-note"><strong>${escapeHtml(readiness)}.</strong> Client outreach: ${escapeHtml(item.outreach.status.replaceAll('_', ' '))}.</p>
        <div class="card-actions"><button class="secondary-button" type="button" data-action="review-recertification" data-recert="${encoded(item.id)}">Review and follow up</button></div>
      </article>`;
    }

    function renderRecertifications() {
      const summary = recertificationEngine.summarize(state.recertifications);
      appRoot.innerHTML = `
      <section>
        <button class="back-button" type="button" data-action="home"><span aria-hidden="true">←</span> Home</button>
        <div class="intro">
          <p class="eyebrow">Recertification status</p>
          <h1>Upcoming renewals</h1>
          <p class="lede">Track every due date, collect missing updates before the deadline, and record the client’s choice about AI-assisted preparation.</p>
        </div>
        ${renderError()}
        <div class="notice"><span aria-hidden="true">i</span><span><strong>${escapeHtml(state.recertificationSource || 'Connected caseload')}.</strong> The dashboard alerts the caseworker. Client messages remain drafts until an authorized worker sends them through an approved channel and marks outreach complete.</span></div>
        <div class="queue-summary recert-summary" aria-label="Recertification summary">
          <span><strong>${summary.total}</strong> clients</span>
          <span><strong>${summary.dueWithin45Days}</strong> due soon</span>
          <span><strong>${summary.needsData}</strong> need data</span>
          <span><strong>${summary.ready}</strong> AI-ready</span>
        </div>
        <div class="stack">${state.recertifications.length ? state.recertifications.map(recertificationCard).join('') : '<div class="notice"><span>✓</span><span>No upcoming recertifications were returned by the connected source.</span></div>'}</div>
        <p class="field-hint">Due dates must come from the authorized source system. The extension does not estimate renewal dates from program enrollment or benefit history.</p>
      </section>`;
    }

    function renderRecertificationDetail() {
      const item = recertificationById();
      if (!item) {
        state.view = 'recertifications';
        return renderRecertifications();
      }
      const notification = recertificationEngine.notificationPlan(item);
      appRoot.innerHTML = `
      <section>
        <button class="back-button" type="button" data-action="back-recertifications"><span aria-hidden="true">←</span> Recertifications</button>
        <div class="intro">
          <p class="eyebrow">${escapeHtml(item.programName)} · ${escapeHtml(item.urgency.label)}</p>
          <h1>${escapeHtml(item.displayName)}</h1>
          <p class="lede">Due ${escapeHtml(recertificationEngine.dueDateLabel(item.dueDate))}. Verify each information area, complete outreach, and record the client’s explicit choice.</p>
        </div>
        ${renderError()}
        <div class="notification-plan">
          <article><span class="section-label">CASEWORKER ALERT</span><strong>${escapeHtml(notification.caseworker.title)}</strong><p>${escapeHtml(notification.caseworker.body)}</p></article>
          <article><span class="section-label">CLIENT MESSAGE DRAFT</span><strong>${escapeHtml(notification.client.title)}</strong><p>${escapeHtml(notification.client.body)}</p><p class="field-hint">Preferred channel: ${escapeHtml(item.outreach.channel)} · ${escapeHtml(item.outreach.status.replaceAll('_', ' '))}</p></article>
        </div>
        <div class="card-actions outreach-actions">
          ${item.outreach.status === 'not_started' ? '<button class="secondary-button" type="button" data-action="draft-recertification-outreach">Create outreach task</button>' : ''}
          ${item.outreach.status === 'drafted' ? '<button class="secondary-button" type="button" data-action="complete-recertification-outreach">Mark client contacted</button>' : ''}
          ${item.outreach.status === 'completed' ? '<span class="automation-badge">✓ Client outreach recorded</span>' : ''}
        </div>
        <form id="recertification-intake-form" class="stack recert-intake">
          <div>
            <p class="section-label">PROACTIVE DATA CHECK</p>
            <p class="card-note">Ask the client these questions before starting the application. Notes and answers stay in this browser session.</p>
          </div>
          ${item.requirements.map((requirement) => `
            <fieldset class="recert-requirement ${['missing', 'stale'].includes(requirement.status) ? 'open' : ''}">
              <legend>${escapeHtml(requirement.label)}</legend>
              <p>${escapeHtml(requirement.question)}</p>
              <label>Status
                <select name="requirement-${escapeHtml(requirement.key)}" required>
                  <option value="missing" ${requirement.status === 'missing' ? 'selected' : ''}>Still needs follow-up</option>
                  <option value="confirmed" ${requirement.status === 'confirmed' ? 'selected' : ''}>Client confirmed current</option>
                  <option value="current" ${requirement.status === 'current' ? 'selected' : ''}>Current source data verified</option>
                  <option value="stale" ${requirement.status === 'stale' ? 'selected' : ''}>Source data may be stale</option>
                </select>
              </label>
              <label>Update or caseworker note
                <textarea name="note-${escapeHtml(requirement.key)}" rows="2" maxlength="240" placeholder="Record the client-provided update or what is still needed.">${escapeHtml(requirement.note)}</textarea>
              </label>
            </fieldset>`).join('')}
          <fieldset class="recert-consent">
            <legend>Client authorization</legend>
            <p>Would you like the AI assistant to prepare your ${escapeHtml(item.programName)} recertification through the review page?</p>
            <label><input type="radio" name="consent" value="authorized" ${item.consent.status === 'authorized' ? 'checked' : ''}> Yes, prepare it for review</label>
            <label><input type="radio" name="consent" value="declined" ${item.consent.status === 'declined' ? 'checked' : ''}> No, do not use AI for this recertification</label>
            <label><input type="radio" name="consent" value="not_asked" ${['not_asked', 'invited'].includes(item.consent.status) ? 'checked' : ''}> Not answered yet</label>
            <p class="field-hint">Authorization covers preparation and form filling only. The assistant never signs, certifies, or submits.</p>
          </fieldset>
          <button class="primary-button" type="submit">Save recertification status</button>
        </form>
        ${item.readyToPrepare ? `
          <div class="ready-recertification">
            <p><strong>Ready to prepare.</strong> The client authorized AI assistance and every required information area is current or confirmed.</p>
            <button class="primary-button" type="button" data-action="prepare-recertification">Prepare with AI</button>
          </div>` : `
          <div class="notice warning"><span aria-hidden="true">!</span><span>The AI run stays locked until all information areas are current or confirmed and the client explicitly authorizes preparation.</span></div>`}
      </section>`;
    }

    return { recertificationCard, renderRecertifications, renderRecertificationDetail };
  }

  const api = { create };

  root.NavaRecertificationViews = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
