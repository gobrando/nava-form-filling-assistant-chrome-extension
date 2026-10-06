// Service-worker coordinator rules: pure normalization, comparison, merge, and assertion rules over coordinator state and application records; assertions throw coordinator errors that coordinationError() turns into responses.
(function installCoordinatorRules(root) {
  'use strict';

  function mergeAudit(current = [], incoming = []) {
    const events = new Map();
    [...current, ...incoming].forEach((event) => {
      if (event?.id) events.set(event.id, event);
    });
    return [...events.values()].sort((left, right) => Date.parse(left.at || 0) - Date.parse(right.at || 0));
  }

  function validCoordinatorId(value) {
    const text = String(value || '');
    if (!/^[a-zA-Z0-9][a-zA-Z0-9:._-]{0,119}$/.test(text)) throw new Error('Invalid application coordination identifier.');
    return text;
  }

  function normalizedGeneration(value) {
    const generation = Number(value);
    return Number.isSafeInteger(generation) && generation >= 0 ? generation : 0;
  }

  function normalizeCoordinator(value) {
    const applicationGenerations = {};
    const applicationRevisions = {};
    Object.entries(value?.applicationGenerations || {}).slice(0, 100).forEach(([id, generation]) => {
      try {
        applicationGenerations[validCoordinatorId(id)] = normalizedGeneration(generation);
      } catch {
        // Ignore malformed persisted coordination metadata.
      }
    });
    Object.entries(value?.applicationRevisions || {}).slice(0, 100).forEach(([id, revision]) => {
      try {
        applicationRevisions[validCoordinatorId(id)] = normalizedGeneration(revision);
      } catch {
        // Ignore malformed persisted coordination metadata.
      }
    });
    return {
      sessionEpoch: Math.max(1, normalizedGeneration(value?.sessionEpoch)),
      applicationGenerations,
      applicationRevisions,
      participantSessionId: /^[a-zA-Z0-9][a-zA-Z0-9:._-]{0,119}$/.test(String(value?.participantSessionId || ''))
        ? String(value.participantSessionId)
        : '',
      stateRevision: Math.max(1, normalizedGeneration(value?.stateRevision)),
      updatedAt: value?.updatedAt || new Date().toISOString(),
    };
  }

  function suppliedGeneration(message, applicationId) {
    return normalizedGeneration(message?.applicationGenerations?.[applicationId] ?? message?.applicationGeneration);
  }

  function suppliedRevision(message, applicationId) {
    return normalizedGeneration(message?.applicationRevisions?.[applicationId] ?? message?.applicationRevision);
  }

  function newParticipantSessionId() {
    return `participant:${globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;
  }

  function coordinatorFields(coordinator) {
    return {
      sessionEpoch: coordinator.sessionEpoch,
      participantSessionId: coordinator.participantSessionId,
      stateRevision: coordinator.stateRevision,
      applicationGenerations: { ...coordinator.applicationGenerations },
      applicationRevisions: { ...coordinator.applicationRevisions },
    };
  }

  function coordinatorError(message, code, coordinator, extras = {}) {
    const error = new Error(message);
    error.code = code;
    error.coordinator = coordinator ? coordinatorFields(coordinator) : null;
    Object.assign(error, extras);
    return error;
  }

  function participantValue(value) {
    if (!value || Array.isArray(value) || typeof value !== 'object') {
      throw new Error('A client session requires one participant record object.');
    }
    return structuredClone(value);
  }

  function sameValue(left, right) {
    try {
      return JSON.stringify(left) === JSON.stringify(right);
    } catch {
      return false;
    }
  }

  function applicationComparable(application) {
    if (!application || typeof application !== 'object') return null;
    const comparable = structuredClone(application);
    delete comparable.controlGeneration;
    delete comparable.controlRevision;
    delete comparable.lease;
    return comparable;
  }

  function applicationChanged(current, incoming) {
    return !sameValue(applicationComparable(current), applicationComparable(incoming));
  }

  function applicationsById(applications = []) {
    return new Map((Array.isArray(applications) ? applications : [])
      .filter((application) => application?.id)
      .map((application) => [application.id, application]));
  }

  function replaceApplications(current = [], incoming = [], changedIds = new Set()) {
    const merged = new Map((Array.isArray(current) ? current : []).map((application) => [application.id, application]));
    (Array.isArray(incoming) ? incoming : []).forEach((application) => {
      if (changedIds.has(application.id)) merged.set(application.id, application);
    });
    return [...merged.values()];
  }

  // Every application id held in the session and the durable queue, session order first.
  function storedApplicationIds(sessionApplications, queueApplications) {
    return [...new Set([
      ...(sessionApplications || []).map((application) => application.id),
      ...(queueApplications || []).map((application) => application.id),
    ].filter(Boolean))];
  }

  function activeLease(lease, now = Date.now()) {
    return Boolean(lease?.holder && Number.isFinite(Date.parse(lease.expiresAt)) && Date.parse(lease.expiresAt) > now);
  }

  // A new generation stops in-flight runs; a new revision rejects snapshots taken before this change.
  function invalidateApplicationRun(coordinator, applicationId) {
    coordinator.applicationGenerations[applicationId] = normalizedGeneration(coordinator.applicationGenerations[applicationId]) + 1;
    coordinator.applicationRevisions[applicationId] = normalizedGeneration(coordinator.applicationRevisions[applicationId]) + 1;
  }

  function revokedApplication(application, { status = 'paused', checkpointKind = 'voluntary_pause', checkpointLabel = 'Paused by caseworker', updatedAt }) {
    if (!application) return application;
    return {
      ...application,
      status,
      autoRun: false,
      lease: null,
      error: status === 'source_expired' ? 'The connected data source changed. Reload the client before resuming.' : '',
      runStopReason: checkpointLabel,
      checkpoint: { kind: checkpointKind, label: checkpointLabel, createdAt: updatedAt },
      updatedAt,
    };
  }

  function assertCoordinatorEpoch(message, coordinator) {
    if (normalizedGeneration(message?.sessionEpoch) !== coordinator.sessionEpoch) {
      throw coordinatorError(
        'This assistant window belongs to an older client session. Reload it before continuing.',
        'STALE_SESSION_EPOCH',
        coordinator,
      );
    }
  }

  function assertStateRevision(message, coordinator) {
    if (normalizedGeneration(message?.stateRevision) !== coordinator.stateRevision) {
      throw coordinatorError(
        'Assistant state changed in another window. Reload the current state before saving.',
        'STALE_STATE_REVISION',
        coordinator,
      );
    }
    return coordinator.stateRevision;
  }

  function assertParticipantSession(message, coordinator, { required = true } = {}) {
    const supplied = String(message?.participantSessionId || '');
    if (!coordinator.participantSessionId) {
      if (!required) return '';
      throw coordinatorError(
        'Claim a client session before saving or using client data.',
        'CLIENT_SESSION_REQUIRED',
        coordinator,
      );
    }
    if (supplied !== coordinator.participantSessionId) {
      throw coordinatorError(
        'A different client session is active in this browser.',
        'PARTICIPANT_SESSION_MISMATCH',
        coordinator,
      );
    }
    return coordinator.participantSessionId;
  }

  function assertApplicationGeneration(message, coordinator, applicationId) {
    const expected = normalizedGeneration(coordinator.applicationGenerations[applicationId]);
    const supplied = suppliedGeneration(message, applicationId);
    if (supplied !== expected) {
      throw coordinatorError(
        'This application run was paused or replaced in another assistant window.',
        'STALE_APPLICATION_GENERATION',
        coordinator,
        { applicationId },
      );
    }
    return expected;
  }

  function assertApplicationRevision(message, coordinator, applicationId) {
    const expected = normalizedGeneration(coordinator.applicationRevisions[applicationId]);
    const supplied = suppliedRevision(message, applicationId);
    if (supplied !== expected) {
      throw coordinatorError(
        'This application changed in another assistant window. Reload it before saving or continuing.',
        'STALE_APPLICATION_REVISION',
        coordinator,
        { applicationId, applicationRevision: expected },
      );
    }
    return expected;
  }

  // A run request must come from the current client session and carry the application's current counters.
  function assertCurrentApplicationRun(message, coordinator, applicationId) {
    assertCoordinatorEpoch(message, coordinator);
    assertParticipantSession(message, coordinator);
    return {
      applicationGeneration: assertApplicationGeneration(message, coordinator, applicationId),
      applicationRevision: assertApplicationRevision(message, coordinator, applicationId),
    };
  }

  function assertActiveLeaseHolder(lease, holder, coordinator, applicationId) {
    if (!activeLease(lease) || lease.holder !== holder) {
      throw coordinatorError(
        'This application run no longer owns the write lease.',
        'LEASE_LOST',
        coordinator,
        { applicationId },
      );
    }
    return lease;
  }

  function assertLeaseNotHeldByOther(lease, holder, coordinator, applicationId) {
    if (activeLease(lease) && lease.holder !== holder) {
      throw coordinatorError(
        'Another assistant window owns this application write lease.',
        'LEASE_HELD',
        coordinator,
        { applicationId },
      );
    }
  }

  function coordinationError(error, extras = {}) {
    const coordinator = error?.coordinator || null;
    return {
      ok: false,
      stale: [
        'STALE_SESSION_EPOCH',
        'STALE_STATE_REVISION',
        'STALE_APPLICATION_GENERATION',
        'STALE_APPLICATION_REVISION',
        'PARTICIPANT_SESSION_MISMATCH',
        'CLIENT_SESSION_CLAIMED',
        'CLIENT_SESSION_REQUIRED',
        'LEASE_LOST',
        'LEASE_HELD',
        'APPLICATION_TAB_MISMATCH',
      ].includes(error?.code),
      code: error?.code || 'COORDINATOR_ERROR',
      error: error?.message || 'The assistant coordinator rejected the operation.',
      ...(coordinator || {}),
      ...(error?.applicationId ? { applicationId: error.applicationId } : {}),
      ...(Number.isSafeInteger(error?.applicationRevision) ? { applicationRevision: error.applicationRevision } : {}),
      ...extras,
    };
  }
  const api = {
    mergeAudit,
    validCoordinatorId,
    normalizedGeneration,
    normalizeCoordinator,
    newParticipantSessionId,
    coordinatorFields,
    coordinatorError,
    participantValue,
    sameValue,
    applicationChanged,
    applicationsById,
    replaceApplications,
    storedApplicationIds,
    activeLease,
    invalidateApplicationRun,
    revokedApplication,
    assertCoordinatorEpoch,
    assertStateRevision,
    assertParticipantSession,
    assertApplicationGeneration,
    assertApplicationRevision,
    assertCurrentApplicationRun,
    assertActiveLeaseHolder,
    assertLeaseNotHeldByOther,
    coordinationError,
  };

  root.NavaCoordinatorRules = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
