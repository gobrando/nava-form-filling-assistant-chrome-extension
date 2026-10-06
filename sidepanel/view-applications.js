// Application queue screens: status labels, the per-application card and its next action, the dashboard, and the pause-or-handoff form.
(function installApplicationViews(root) {
  'use strict';

  /**
   * deps:
   * - state, appRoot: panel state and the screen root.
   * - format: NavaPanelFormat helpers.
   * - isRunning(applicationId): whether an automated run currently owns the application.
   * - renderError(), renderAgentRuntime(), firstName(): shared panel helpers.
   */
  function create(deps) {
    const {
      state,
      appRoot,
      format,
      isRunning,
      renderError,
      renderAgentRuntime,
      firstName,
    } = deps;
    const { escapeHtml, encoded, hostLabel, progressFor, agentUsageSummary } = format;

    function statusLabel(application) {
      if (isRunning(application.id)) return 'Running automatically';
      if (application.status === 'ready_for_review') return 'Ready for review';
      if (application.status === 'needs_attention') return 'Needs your attention';
      if (application.status === 'ready_to_fill') return 'Ready to fill';
      if (application.status === 'no_form') return 'No form found';
      if (application.status === 'paused') return 'Paused safely';
      if (application.status === 'handoff_pending') return 'Handoff waiting';
      if (application.status === 'source_expired') return 'Reload source data';
      if (application.status === 'not_started' && application.autoRun) return 'Starting automatically';
      return 'Not started';
    }

    function applicationCard(application) {
      const card = {
        application,
        running: isRunning(application.id),
        review: application.status === 'ready_for_review',
        attention: ['needs_attention', 'no_form', 'paused', 'handoff_pending', 'source_expired'].includes(application.status),
        gaps: application.analysis?.gaps?.length || 0,
        blocked: application.blocked?.length || 0,
      };
      const { review, attention } = card;
      return `
      <article class="application-card ${attention ? 'attention' : ''} ${review ? 'review' : ''}">
        <div class="card-row">
          <div class="card-heading">
            <span class="status-icon" aria-hidden="true">${review ? '✓' : attention ? '!' : '•'}</span>
            <div><strong>${escapeHtml(application.name)}</strong><p class="card-note">${escapeHtml(hostLabel(application.url))}</p></div>
          </div>
          <div aria-label="${progressFor(application)} percent complete" class="progress-track"><div class="progress-fill" style="width:${progressFor(application)}%"></div></div>
        </div>
        <p class="card-note"><strong>${escapeHtml(statusLabel(application))}.</strong> ${escapeHtml(cardNote(card))}</p>
        ${cardDetails(application)}
        <div class="card-actions">${cardActions(card)}</div>
      </article>`;
    }

    /** The most specific explanation of where the application stands, live run progress first. */
    function cardNote({ application, running, review, gaps, blocked }) {
      return (running ? application.runProgress : '')
        || application.error
        || application.runStopReason
        || (blocked ? `${blocked} fields need direct help` : '')
        || (gaps ? `${gaps} answers are needed before this page is complete` : '')
        || (review ? (application.runStopReason || 'All writes were read back and verified') : 'Ready to fill the values found in the client record');
    }

    function agentPlanBadge(agentic) {
      return `<p class="automation-badge">AI-reviewed plan · ${Number(agentic.approvedMappings || 0)} mapping${Number(agentic.approvedMappings || 0) === 1 ? '' : 's'} · ${agentic.provider === 'codex' ? 'Codex' : agentic.provider === 'claude' ? 'Claude' : 'Gemini Nano'} mapper + gap analyst + reviewer</p>`;
    }

    /** Ownership, checkpoint, AI-plan, model-usage, and completed-page lines (each only when it applies). */
    function cardDetails(application) {
      const completedPages = application.completedPages?.length || 0;
      return `${application.owner ? `<p class="ownership-line"><span class="owner-chip ${application.owner.state}">${application.owner.state === 'pending' ? 'Assigned to' : 'Owned by'} ${escapeHtml(application.owner.assignedTo)}</span></p>` : ''}
        ${application.checkpoint ? `<p class="checkpoint-line"><strong>Checkpoint:</strong> ${escapeHtml(application.checkpoint.label)}</p>` : ''}
        ${application.agentic ? agentPlanBadge(application.agentic) : ''}
        ${application.agentic?.usage ? `<p class="card-note">${escapeHtml(agentUsageSummary(application.agentic))}</p>` : ''}
        ${completedPages ? `<p class="automation-badge">✓ ${completedPages} page${completedPages === 1 ? '' : 's'} completed automatically</p>` : ''}`;
    }

    /**
     * The card's primary action: the first rule whose `when` matches wins, so order is precedence.
     * A live run hides every action; human checkpoints (CAPTCHA, one-time code) outrank resume and fill.
     */
    const CARD_ACTIONS = [
      {
        when: ({ running }) => running,
        render: () => '<span class="automation-badge">Scanning, filling, and continuing in this application tab…</span>',
      },
      {
        when: ({ application }) => application.status === 'source_expired',
        render: () => '<button class="small-button" type="button" data-action="reload-source">Reload client data</button>',
      },
      {
        when: ({ application }) => application.status === 'handoff_pending',
        render: ({ application }) => `<button class="small-button" type="button" data-action="accept-handoff" data-app="${encoded(application.id)}">Accept handoff</button>`,
      },
      {
        when: ({ application }) => application.programSelectionRequired,
        render: () => '<button class="small-button" type="button" data-action="add-application">Choose programs in a new BenefitsCal application</button>',
      },
      {
        when: ({ application }) => ['captcha', 'otp'].includes(application.checkpoint?.kind) && application.tabId,
        render: ({ application }) => {
          const challenge = application.checkpoint.kind === 'captcha' ? 'CAPTCHA' : 'one-time code';
          return `<button class="small-button" type="button" data-action="resume-human-checkpoint" data-app="${encoded(application.id)}">I completed the ${challenge} — resume</button>`;
        },
      },
      {
        when: ({ application }) => application.status === 'paused',
        render: ({ application }) => `<button class="small-button" type="button" data-action="${application.tabId ? 'resume' : 'resume-current'}" data-app="${encoded(application.id)}">${application.tabId ? 'Verify and resume' : 'Reconnect current tab'}</button>`,
      },
      {
        when: ({ application }) => application.status === 'not_started' && application.autoRun,
        render: () => '<span class="automation-badge">Opening, scanning, and continuing in this tab…</span>',
      },
      {
        when: ({ application }) => application.status === 'not_started' && application.tabId,
        render: ({ application }) => `<button class="small-button" type="button" data-action="scan-application" data-app="${encoded(application.id)}">Scan application</button>`,
      },
      {
        when: ({ attention, gaps }) => attention && gaps,
        render: ({ application }) => `<button class="small-button" type="button" data-action="answer-run" data-app="${encoded(application.id)}">Answer and continue</button>
        <button class="small-button secondary" type="button" data-action="answer" data-app="${encoded(application.id)}">This page only</button>`,
      },
      {
        when: ({ application }) => application.status === 'ready_to_fill',
        render: ({ application }) => `<button class="small-button" type="button" data-action="run" data-app="${encoded(application.id)}">Fill through application</button>
        <button class="small-button secondary" type="button" data-action="fill" data-app="${encoded(application.id)}">This page only</button>`,
      },
      {
        when: ({ review }) => review,
        render: ({ application }) => `<button class="small-button secondary" type="button" data-action="review" data-app="${encoded(application.id)}">Review details</button>`,
      },
      {
        when: ({ application }) => application.tabId,
        render: ({ application }) => `<button class="small-button" type="button" data-action="scan-application" data-app="${encoded(application.id)}">Scan this application</button>`,
      },
      {
        when: () => true,
        render: ({ application }) => `<button class="small-button" type="button" data-action="resume-current" data-app="${encoded(application.id)}">Reconnect current tab</button>`,
      },
    ];

    /** The primary action, then pause-or-handoff while the work is still open, then a jump to the tab. */
    function cardActions(card) {
      const { application } = card;
      let actions = CARD_ACTIONS.find((rule) => rule.when(card)).render(card);
      if (!['source_expired', 'handoff_pending', 'ready_for_review'].includes(application.status)) {
        actions += `<button class="small-button secondary" type="button" data-action="open-handoff" data-app="${encoded(application.id)}">Pause or hand off</button>`;
      }
      if (application.tabId) actions += `<button class="small-button secondary" type="button" data-action="go-tab" data-app="${encoded(application.id)}">Go to application</button>`;
      return actions;
    }

    function renderDashboard() {
      const groups = [
        ['NEEDS YOUR ATTENTION', state.apps.filter((item) => ['needs_attention', 'no_form', 'paused', 'handoff_pending', 'source_expired'].includes(item.status))],
        ['IN PROGRESS', state.apps.filter((item) => ['not_started', 'ready_to_fill'].includes(item.status))],
        ['READY FOR REVIEW', state.apps.filter((item) => item.status === 'ready_for_review')],
      ];
      appRoot.innerHTML = `
      <section>
        <div class="intro">
          <p class="eyebrow">Application dashboard</p>
          <h1>${state.participant ? `${escapeHtml(firstName())}'s applications` : 'Resumable work queue'}</h1>
          <p class="lede">${state.participant ? 'The assistant can resume verified pages and continue across approved application steps. It always stops before certification, signature, or submission.' : 'Application progress survived, but client values expired with the browser session. Reload the source record before any application can resume.'}</p>
        </div>
        ${renderError()}
        ${renderAgentRuntime()}
        <div class="queue-summary" aria-label="Work queue summary">
          <span><strong>${state.apps.length}</strong> applications</span>
          <span><strong>${state.apps.filter((item) => ['needs_attention', 'paused', 'handoff_pending', 'source_expired'].includes(item.status)).length}</strong> checkpoints</span>
          <span><strong>${state.apps.filter((item) => item.status === 'ready_for_review').length}</strong> ready</span>
        </div>
        ${groups.map(([label, apps]) => apps.length ? `
          <p class="section-label">${label}</p>
          <div class="stack">${apps.map(applicationCard).join('')}</div>` : '').join('')}
        ${state.apps.length ? '' : '<div class="notice"><span>i</span><span>No application has been added yet.</span></div>'}
        <div class="form-actions">
          <button class="secondary-button" type="button" data-action="open-recertifications">Recertification status</button>
          <button class="secondary-button" type="button" data-action="${state.participant ? 'add-application' : 'reload-source'}">${state.participant ? 'Add another application' : 'Reload client data'}</button>
          <button class="secondary-button" type="button" data-action="export-audit">Export activity log</button>
          <button class="link-button" type="button" data-action="start-over">End this session</button>
        </div>
      </section>`;
    }

    function renderHandoff() {
      const application = state.apps.find((item) => item.id === state.handoffApplicationId);
      if (!application) {
        state.view = 'dashboard';
        return renderDashboard();
      }
      appRoot.innerHTML = `
      <section>
        <button class="back-button" type="button" data-action="back-dashboard"><span aria-hidden="true">←</span> Back</button>
        <div class="intro">
          <p class="eyebrow">${escapeHtml(application.name)}</p>
          <h1>Pause or hand off</h1>
          <p class="lede">Save an explicit checkpoint so another caseworker or team can understand what needs attention before resuming.</p>
        </div>
        ${renderError()}
        <div class="notice"><span aria-hidden="true">i</span><span>The durable queue stores workflow metadata only. Do not put client names, identifiers, or answers in the assignee field.</span></div>
        <form id="handoff-form">
          <div class="form-stack">
            <label>Caseworker or team
              <input name="assignedTo" type="text" maxlength="80" autocomplete="off" placeholder="Example: Intake team" required>
            </label>
            <label>Reason for handoff
              <select name="reason">
                <option value="client_question">Client question needed</option>
                <option value="direct_entry">Direct form entry needed</option>
                <option value="captcha_or_otp">CAPTCHA or one-time code</option>
                <option value="certification_or_signature">Certification or signature</option>
                <option value="supervisor_review">Supervisor review</option>
                <option value="other">Other checkpoint</option>
              </select>
            </label>
          </div>
          <div class="form-actions">
            <button class="primary-button" type="submit">Create handoff</button>
            <button class="secondary-button" type="button" data-action="pause" data-app="${encoded(application.id)}">Pause for later</button>
          </div>
        </form>
      </section>`;
    }

    return { statusLabel, applicationCard, renderDashboard, renderHandoff };
  }

  const api = { create };

  root.NavaApplicationViews = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
