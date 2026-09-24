(function installWorkQueueEngine(root) {
  'use strict';

  const QUEUE_VERSION = 2;
  const MAX_APPLICATIONS = 50;
  const MAX_AUDIT_EVENTS = 500;
  const DEFAULT_LEASE_MS = 2 * 60 * 1000;
  const STATUS_VALUES = new Set([
    'not_started',
    'ready_to_fill',
    'needs_attention',
    'no_form',
    'paused',
    'handoff_pending',
    'ready_for_review',
    'source_expired',
  ]);
  const CHECKPOINT_VALUES = new Set([
    'human_input',
    'direct_entry',
    'captcha',
    'otp',
    'certification',
    'signature',
    'final_review',
    'navigation_unknown',
    'tab_closed',
    'source_expired',
    'source_stale',
    'page_changed',
    'handoff',
    'voluntary_pause',
  ]);
  const EVENT_TYPES = new Set([
    'application_added',
    'scan_completed',
    'questions_required',
    'fill_started',
    'page_verified',
    'safe_advance',
    'checkpoint_reached',
    'checkpoint_completed',
    'resume_verified',
    'resume_rejected',
    'handoff_created',
    'handoff_accepted',
    'review_reached',
    'tab_closed',
    'source_reloaded',
    'session_ended',
    'audit_exported',
  ]);
  const DETAIL_ENUMS = {
    checkpointKind: CHECKPOINT_VALUES,
    resumeOutcome: new Set(['verified', 'source_expired', 'source_stale', 'tab_closed', 'location_changed', 'page_changed', 'handoff_pending']),
    fromStatus: STATUS_VALUES,
    toStatus: STATUS_VALUES,
    modelRuntime: new Set(['chrome-gemini-nano', 'codex-cli-subscription', 'claude-cli-subscription', 'managed-cloud']),
  };
  const COUNT_KEYS = new Set([
    'fieldCount',
    'gapCount',
    'verifiedCount',
    'blockedCount',
    'pageCount',
    'modelPromptCount',
    'modelDurationMs',
    'modelInputTokens',
    'modelOutputTokens',
    'modelApiCostMicros',
  ]);
  const COUNT_MAXIMUMS = {
    modelPromptCount: 1_000,
    modelDurationMs: 600_000,
    modelInputTokens: 5_000_000,
    modelOutputTokens: 5_000_000,
    modelApiCostMicros: 100_000_000,
  };

  function cleanText(value, limit = 100) {
    return String(value || '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, limit);
  }

  function safeLocation(value) {
    try {
      const url = new URL(String(value || ''));
      if (!['http:', 'https:'].includes(url.protocol)) return '';
      return `${url.origin}${url.pathname}`;
    } catch {
      return '';
    }
  }

  function safeOrigin(value) {
    try {
      const url = new URL(String(value || ''));
      return ['http:', 'https:'].includes(url.protocol) ? url.origin : '';
    } catch {
      return '';
    }
  }

  function safeIso(value, fallback = Date.now()) {
    const date = new Date(value || fallback);
    return Number.isFinite(date.getTime()) ? date.toISOString() : new Date(fallback).toISOString();
  }

  function signatureHash(value) {
    const text = String(value || '');
    if (!text) return '';
    let hash = 0x811c9dc5;
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193);
    }
    return `fnv1a32:${(hash >>> 0).toString(16).padStart(8, '0')}`;
  }

  function boundedCount(value, maximum = 10000) {
    return Math.min(maximum, Math.max(0, Math.round(Number(value) || 0)));
  }

  function safeProgramIds(values) {
    const allowed = new Set(['calfresh', 'medical', 'calworks', 'wic', 'ihss']);
    return [...new Set((Array.isArray(values) ? values : []).filter((value) => allowed.has(value)))];
  }

  function hasOwn(input, key) {
    return Boolean(input && Object.prototype.hasOwnProperty.call(input, key));
  }

  function isBenefitsCalApplication(saved, session) {
    if (cleanText(saved?.workflowId || session?.workflowId, 60).toLowerCase() === 'benefitscal') return true;
    return [
      saved?.location,
      saved?.resumePoint?.location,
      session?.url,
      session?.page?.url,
      session?.resumePoint?.location,
    ].some((value) => {
      const origin = safeOrigin(value);
      if (!origin) return false;
      return new URL(origin).hostname.toLowerCase().replace(/^www\./, '') === 'benefitscal.com';
    });
  }

  function safeOrigins(values) {
    return [...new Set((Array.isArray(values) ? values : []).map(safeOrigin).filter(Boolean))].slice(0, 8);
  }

  function safePathPrefixes(values) {
    return [...new Set((Array.isArray(values) ? values : [])
      .map((value) => cleanText(value, 120))
      .filter((value) => value.startsWith('/') && !value.includes('?') && !value.includes('#')))]
      .slice(0, 12);
  }

  function normalizedStatus(value, fallback = 'not_started') {
    return STATUS_VALUES.has(value) ? value : fallback;
  }

  function normalizedCheckpoint(input) {
    if (!input || !CHECKPOINT_VALUES.has(input.kind)) return null;
    return {
      kind: input.kind,
      label: cleanText(input.label, 80),
      createdAt: safeIso(input.createdAt),
    };
  }

  function normalizedOwner(input) {
    if (!input?.assignedTo) return null;
    return {
      assignedTo: cleanText(input.assignedTo, 80),
      state: input.state === 'pending' ? 'pending' : 'active',
      assignedAt: safeIso(input.assignedAt),
    };
  }

  function normalizedHandoff(input) {
    if (!input?.to) return null;
    const reasons = new Set(['client_question', 'direct_entry', 'captcha_or_otp', 'certification_or_signature', 'supervisor_review', 'other']);
    return {
      to: cleanText(input.to, 80),
      reason: reasons.has(input.reason) ? input.reason : 'other',
      createdAt: safeIso(input.createdAt),
      acceptedAt: input.acceptedAt ? safeIso(input.acceptedAt) : null,
    };
  }

  function normalizedLease(input) {
    if (!input?.holder || !Number.isFinite(Date.parse(input.expiresAt))) return null;
    return {
      holder: cleanText(input.holder, 80),
      acquiredAt: safeIso(input.acquiredAt),
      expiresAt: safeIso(input.expiresAt),
    };
  }

  function durableApplication(application) {
    const fullLocation = safeLocation(application.resumePoint?.location || application.url || application.page?.url);
    const location = safeOrigin(fullLocation);
    const rawSignature = application.resumePoint?.pageSignature || application.navigationGate?.pageSignature || '';
    const suppliedSignatureHash = String(application.resumePoint?.pageSignatureHash || '');
    const inferredProgress = {
      not_started: 8,
      source_expired: 8,
      paused: 20,
      handoff_pending: 20,
      ready_to_fill: 35,
      needs_attention: 55,
      no_form: 55,
      ready_for_review: 100,
    }[normalizedStatus(application.status)] || 0;
    const durable = {
      id: cleanText(application.id, 100),
      name: cleanText(application.queueLabel || application.name || 'Application', 80),
      workflowId: cleanText(application.workflowId, 60),
      allowedOrigins: safeOrigins(application.allowedOrigins),
      allowedPathPrefixes: safePathPrefixes(application.allowedPathPrefixes),
      location,
      tabId: Number.isInteger(application.tabId) ? application.tabId : null,
      status: normalizedStatus(application.status),
      progress: boundedCount(application.progress ?? inferredProgress, 100),
      completedPages: boundedCount(application.completedPages?.length ?? application.completedPages, 100),
      checkpoint: normalizedCheckpoint(application.checkpoint),
      owner: normalizedOwner(application.owner),
      handoff: normalizedHandoff(application.handoff),
      lease: normalizedLease(application.lease),
      resumePoint: location ? {
        location,
        locationHash: signatureHash(fullLocation),
        pageSignatureHash: /^fnv1a32:[a-f0-9]{8}$/.test(suppliedSignatureHash) ? suppliedSignatureHash : signatureHash(rawSignature || suppliedSignatureHash),
        capturedAt: safeIso(application.resumePoint?.capturedAt || application.updatedAt),
      } : null,
      updatedAt: safeIso(application.updatedAt),
    };
    if (hasOwn(application, 'programIds')) durable.programIds = safeProgramIds(application.programIds);
    if (application.programSelectionRequired === true) durable.programSelectionRequired = true;
    return durable;
  }

  function sanitizeDetails(details) {
    const output = {};
    Object.entries(details || {}).forEach(([key, value]) => {
      if (COUNT_KEYS.has(key)) output[key] = boundedCount(value, COUNT_MAXIMUMS[key] || 10_000);
      else if (DETAIL_ENUMS[key]?.has(value)) output[key] = value;
      else if (key === 'actor') output.actor = cleanText(value, 80);
    });
    return output;
  }

  function auditEvent(type, application, details = {}, options = {}) {
    if (!EVENT_TYPES.has(type)) throw new Error('Unsupported audit event type.');
    const at = safeIso(options.at);
    return {
      id: cleanText(options.id || `${Date.parse(at)}:${Math.random().toString(36).slice(2, 10)}`, 100),
      type,
      at,
      applicationId: cleanText(application?.id, 100),
      details: sanitizeDetails(details),
    };
  }

  function appendAudit(events, event) {
    return [...(Array.isArray(events) ? events : []), event].slice(-MAX_AUDIT_EVENTS);
  }

  function sanitizeAudit(events) {
    return (Array.isArray(events) ? events : []).filter((event) => EVENT_TYPES.has(event?.type)).map((event) => ({
      id: cleanText(event.id, 100),
      type: event.type,
      at: safeIso(event.at),
      applicationId: cleanText(event.applicationId, 100),
      details: sanitizeDetails(event.details),
    })).slice(-MAX_AUDIT_EVENTS);
  }

  function buildQueue(applications, audit = []) {
    return {
      version: QUEUE_VERSION,
      applications: (Array.isArray(applications) ? applications : []).slice(0, MAX_APPLICATIONS).map(durableApplication),
      audit: sanitizeAudit(audit),
      updatedAt: safeIso(),
    };
  }

  function restoreApplications(queue, sessionApplications = []) {
    const legacyQueue = !Number.isFinite(Number(queue?.version)) || Number(queue.version) < 2;
    const live = new Map((Array.isArray(sessionApplications) ? sessionApplications : []).map((application) => [application.id, application]));
    return (queue?.applications || []).map((saved) => {
      const session = live.get(saved.id);
      const savedHasProgramIds = hasOwn(saved, 'programIds');
      const programSelectionRequired = saved.programSelectionRequired === true
        || (legacyQueue && !savedHasProgramIds && isBenefitsCalApplication(saved, session));
      if (session) {
        live.delete(saved.id);
        const restored = {
          ...session,
          workflowId: saved.workflowId || session.workflowId,
          allowedOrigins: saved.allowedOrigins?.length ? saved.allowedOrigins : session.allowedOrigins,
          allowedPathPrefixes: saved.allowedPathPrefixes?.length ? saved.allowedPathPrefixes : session.allowedPathPrefixes,
          tabId: saved.tabId,
          status: programSelectionRequired ? 'paused' : saved.status,
          owner: saved.owner,
          handoff: saved.handoff,
          checkpoint: programSelectionRequired ? {
            kind: 'human_input',
            label: 'Choose BenefitsCal programs',
            createdAt: new Date().toISOString(),
          } : saved.checkpoint || session.checkpoint,
          lease: saved.lease,
          resumePoint: session.resumePoint ? {
            ...session.resumePoint,
            locationHash: saved.resumePoint?.locationHash || session.resumePoint.locationHash,
            pageSignatureHash: saved.resumePoint?.pageSignatureHash || session.resumePoint.pageSignatureHash,
          } : saved.resumePoint,
          updatedAt: saved.updatedAt || session.updatedAt,
        };
        if (savedHasProgramIds) restored.programIds = safeProgramIds(saved.programIds);
        else if (programSelectionRequired || !hasOwn(session, 'programIds')) delete restored.programIds;
        else restored.programIds = safeProgramIds(session.programIds);
        if (programSelectionRequired) {
          restored.programSelectionRequired = true;
          restored.autoRun = false;
          restored.error = 'Choose which BenefitsCal programs this application includes before resuming.';
        } else {
          delete restored.programSelectionRequired;
        }
        return restored;
      }
      const restored = {
        id: saved.id,
        name: saved.name,
        queueLabel: saved.name,
        workflowId: saved.workflowId,
        allowedOrigins: saved.allowedOrigins || [],
        allowedPathPrefixes: saved.allowedPathPrefixes || [],
        url: saved.location,
        tabId: saved.tabId,
        status: 'source_expired',
        error: 'Client source data expired when the browser session ended. Reload the client before resuming.',
        checkpoint: { kind: 'source_expired', label: 'Reload client data', createdAt: new Date().toISOString() },
        owner: saved.owner,
        handoff: saved.handoff,
        lease: saved.lease,
        resumePoint: saved.resumePoint,
        completedPages: Array.from({ length: saved.completedPages }, () => ({ durablePlaceholder: true })),
        updatedAt: saved.updatedAt,
        durableOnly: true,
      };
      if (savedHasProgramIds) restored.programIds = safeProgramIds(saved.programIds);
      if (programSelectionRequired) restored.programSelectionRequired = true;
      return restored;
    }).concat([...live.values()]);
  }

  function resumeDecision(application, livePage, options = {}) {
    if (!options.sourceAvailable) return { allowed: false, outcome: 'source_expired', checkpointKind: 'source_expired', reason: 'Reload the client source before resuming.' };
    if (options.sourceStale) return { allowed: false, outcome: 'source_stale', checkpointKind: 'source_stale', reason: 'Refresh the stale source record before resuming.' };
    if (application.handoff && !application.handoff.acceptedAt) return { allowed: false, outcome: 'handoff_pending', checkpointKind: 'handoff', reason: 'Accept the handoff before resuming.' };
    if (!livePage?.url) return { allowed: false, outcome: 'tab_closed', checkpointKind: 'tab_closed', reason: 'Open the saved application page before resuming.' };
    const currentLocation = safeLocation(livePage.url);
    const expectedLocationHash = application.resumePoint?.locationHash
      || signatureHash(safeLocation(application.resumePoint?.location || application.url));
    if (!expectedLocationHash || expectedLocationHash !== signatureHash(currentLocation)) {
      return { allowed: false, outcome: 'location_changed', checkpointKind: 'page_changed', reason: 'The open tab is not at the saved application location.' };
    }
    const expectedSignature = application.resumePoint?.pageSignatureHash || '';
    const currentSignature = signatureHash(livePage.pageSignature);
    if (expectedSignature && expectedSignature !== currentSignature) {
      return { allowed: false, outcome: 'page_changed', checkpointKind: 'page_changed', reason: 'The application page changed since it was paused. Review and rescan before filling.' };
    }
    return { allowed: true, outcome: 'verified', checkpointKind: null, reason: 'The saved page location and signature were verified.' };
  }

  function acquireLease(application, holder, options = {}) {
    const now = Number(options.now || Date.now());
    const leaseMs = Math.min(10 * 60 * 1000, Math.max(5000, Number(options.leaseMs) || DEFAULT_LEASE_MS));
    const active = application.lease && Date.parse(application.lease.expiresAt) > now;
    if (active && application.lease.holder !== holder) {
      return { allowed: false, lease: application.lease, reason: 'Another assistant window is already working on this application.' };
    }
    return {
      allowed: true,
      lease: {
        holder: cleanText(holder, 80),
        acquiredAt: new Date(now).toISOString(),
        expiresAt: new Date(now + leaseMs).toISOString(),
      },
    };
  }

  function releaseLease(application, holder) {
    if (!application.lease || application.lease.holder === holder) return { ...application, lease: null };
    return application;
  }

  function markTabClosed(queue, tabId, options = {}) {
    const at = safeIso(options.at);
    let changedApplication;
    const applications = (queue?.applications || []).map((application) => {
      if (application.tabId !== tabId) return application;
      changedApplication = {
        ...application,
        tabId: null,
        status: application.status === 'ready_for_review' ? application.status : 'paused',
        checkpoint: { kind: 'tab_closed', label: 'Application tab closed', createdAt: at },
        lease: null,
        updatedAt: at,
      };
      return changedApplication;
    });
    if (!changedApplication) return queue;
    const event = auditEvent('tab_closed', changedApplication, { checkpointKind: 'tab_closed', toStatus: changedApplication.status }, { at, id: options.id });
    return { ...queue, applications, audit: appendAudit(queue.audit, event), updatedAt: at };
  }

  function exportAudit(queue, options = {}) {
    const safeQueue = buildQueue(queue?.applications || [], queue?.audit || []);
    return {
      schema: 'nava.form-filling.audit.v1',
      generatedAt: safeIso(options.at),
      applications: safeQueue.applications.map((application) => ({
        id: application.id,
        name: application.name,
        location: application.location,
        status: application.status,
        progress: application.progress,
        completedPages: application.completedPages,
        checkpoint: application.checkpoint,
        owner: application.owner,
        handoff: application.handoff,
        updatedAt: application.updatedAt,
      })),
      events: safeQueue.audit,
    };
  }

  const api = {
    DEFAULT_LEASE_MS,
    MAX_APPLICATIONS,
    MAX_AUDIT_EVENTS,
    QUEUE_VERSION,
    acquireLease,
    appendAudit,
    auditEvent,
    buildQueue,
    durableApplication,
    exportAudit,
    markTabClosed,
    releaseLease,
    restoreApplications,
    resumeDecision,
    safeLocation,
    safeOrigin,
    signatureHash,
  };

  root.NavaWorkQueueEngine = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
