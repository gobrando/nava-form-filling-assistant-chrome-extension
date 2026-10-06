// Service worker: owns the assistant coordinator (client session, application runs, write leases) and the read-only connector client.
import './shared/connector-engine.js';
import './shared/work-queue-engine.js';
import './shared/program-catalog.js';
import './shared/recertification-engine.js';

const connectorEngine = globalThis.NavaConnectorEngine;
const workQueueEngine = globalThis.NavaWorkQueueEngine;
const programCatalog = globalThis.NavaProgramCatalog;
const recertificationEngine = globalThis.NavaRecertificationEngine;
const CONNECTOR_STORAGE_KEY = 'nava:connector';
const QUEUE_STORAGE_KEY = 'nava:work-queue';
const LEASE_STORAGE_KEY = 'nava:application-leases';
const SESSION_STORAGE_KEY = 'nava:session';
const COORDINATOR_STORAGE_KEY = 'nava:assistant-coordinator';
const APPLICATION_COMMAND_TYPES = new Set(['NAVA_SCAN', 'NAVA_FILL', 'NAVA_NAVIGATION_STATUS', 'NAVA_ADVANCE']);
const WRITE_COMMAND_TYPES = new Set(['NAVA_FILL', 'NAVA_ADVANCE']);
const ACTIVE_LEASE_MS = 2 * 60 * 1000;
const COMMAND_LEASE_MS = 10 * 60 * 1000;
const activeCommandTargets = new Map();
let coordinatorChain = Promise.resolve();

// ---------------------------------------------------------------------------
// Coordinator core: one serialized chain over the coordinator, session, queue, and lease stores, plus the
// in-flight tab commands that a revocation must cancel.
// ---------------------------------------------------------------------------

function coordinate(operation) {
  const next = coordinatorChain.catch(() => {}).then(operation);
  coordinatorChain = next;
  return next;
}

async function coordinatorState() {
  const result = await chrome.storage.local.get(COORDINATOR_STORAGE_KEY);
  const coordinator = normalizeCoordinator(result[COORDINATOR_STORAGE_KEY]);
  if (!result[COORDINATOR_STORAGE_KEY]) {
    await chrome.storage.local.set({ [COORDINATOR_STORAGE_KEY]: coordinator });
  }
  return coordinator;
}

// The four stores a coordinated write reads together, with their empty defaults.
async function readCoordinatedState() {
  const [coordinator, sessionResult, queueResult, leaseResult] = await Promise.all([
    coordinatorState(),
    chrome.storage.session.get(SESSION_STORAGE_KEY),
    chrome.storage.local.get(QUEUE_STORAGE_KEY),
    chrome.storage.local.get(LEASE_STORAGE_KEY),
  ]);
  return {
    coordinator,
    session: sessionResult[SESSION_STORAGE_KEY] || {},
    queue: queueResult[QUEUE_STORAGE_KEY] || { applications: [], audit: [] },
    leases: { ...(leaseResult[LEASE_STORAGE_KEY] || {}) },
  };
}

// Runs one operation on the coordinator chain and answers asynchronously; failures use the coordination error shape.
function respondCoordinated(operation, sendResponse, errorExtras) {
  coordinate(operation)
    .then(sendResponse)
    .catch((error) => sendResponse(coordinationError(error, errorExtras)));
  return true;
}

async function shortenCommandLease(applicationId, holder) {
  const result = await chrome.storage.local.get(LEASE_STORAGE_KEY);
  const leases = { ...(result[LEASE_STORAGE_KEY] || {}) };
  const lease = leases[applicationId];
  if (!activeLease(lease) || lease.holder !== holder) return;
  leases[applicationId] = {
    ...lease,
    expiresAt: new Date(Date.now() + ACTIVE_LEASE_MS).toISOString(),
  };
  await chrome.storage.local.set({ [LEASE_STORAGE_KEY]: leases });
}

function registerCommandTarget(applicationId, target) {
  const commands = activeCommandTargets.get(applicationId) || new Map();
  const commandId = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  commands.set(commandId, target);
  activeCommandTargets.set(applicationId, commands);
  return () => {
    const active = activeCommandTargets.get(applicationId);
    active?.delete(commandId);
    if (!active?.size) activeCommandTargets.delete(applicationId);
  };
}

function cancelApplicationTargets(applicationIds, sessionApplications = []) {
  const ids = new Set(applicationIds);
  const targets = new Map();
  (sessionApplications || [])
    .filter((application) => ids.has(application.id) && Number.isInteger(application.tabId))
    .forEach((application) => targets.set(`${application.tabId}:`, { tabId: application.tabId }));
  ids.forEach((id) => {
    activeCommandTargets.get(id)?.forEach((target) => {
      targets.set(`${target.tabId}:${target.documentId || ''}`, target);
    });
  });
  targets.forEach((target) => {
    const options = target.documentId ? { documentId: target.documentId } : undefined;
    void Promise.resolve()
      .then(() => chrome.tabs.sendMessage(target.tabId, { type: 'NAVA_CANCEL' }, options))
      .catch(() => {});
  });
}

async function revokeApplications({ applicationIds, status, checkpointKind, checkpointLabel }) {
  const ids = [...new Set((applicationIds || []).map(validCoordinatorId))];
  const updatedAt = new Date().toISOString();
  const { coordinator, session, queue, leases } = await readCoordinatedState();
  ids.forEach((id) => {
    invalidateApplicationRun(coordinator, id);
    delete leases[id];
  });
  cancelApplicationTargets(ids, session.apps || []);
  coordinator.stateRevision += 1;
  coordinator.updatedAt = updatedAt;
  const options = { status, checkpointKind, checkpointLabel, updatedAt };
  const revoke = (application) => ids.includes(application.id) ? revokedApplication(application, options) : application;
  const nextSession = {
    ...session,
    apps: (session.apps || []).map(revoke),
  };
  const nextQueue = workQueueEngine.buildQueue(
    (queue.applications || []).map(revoke),
    queue.audit || [],
  );
  await Promise.all([
    chrome.storage.local.set({
      [COORDINATOR_STORAGE_KEY]: coordinator,
      [LEASE_STORAGE_KEY]: leases,
      [QUEUE_STORAGE_KEY]: nextQueue,
    }),
    chrome.storage.session.set({ [SESSION_STORAGE_KEY]: nextSession }),
  ]);
  return { coordinator, session: nextSession, queue: nextQueue };
}

// ---------------------------------------------------------------------------
// Coordinator rules: pure normalization, comparison, merge, and assertion rules over coordinator state and
// application records. Assertions throw coordinator errors that coordinationError() turns into responses.
// ---------------------------------------------------------------------------

function updatedTime(application) {
  const value = Date.parse(application?.updatedAt || '');
  return Number.isFinite(value) ? value : 0;
}

function mergeApplications(current = [], incoming = []) {
  const merged = new Map(current.map((application) => [application.id, application]));
  incoming.forEach((application) => {
    const previous = merged.get(application.id);
    if (!previous || updatedTime(application) >= updatedTime(previous)) merged.set(application.id, application);
  });
  return [...merged.values()];
}

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

// ---------------------------------------------------------------------------
// Session handlers: the browser's single claimed client session and the assistant state snapshot
// (session applications plus the durable queue) that side-panel windows save and restore.
// ---------------------------------------------------------------------------

async function getAssistantState() {
  const [coordinator, sessionResult, queueResult] = await Promise.all([
    coordinatorState(),
    chrome.storage.session.get(SESSION_STORAGE_KEY),
    chrome.storage.local.get(QUEUE_STORAGE_KEY),
  ]);
  const session = sessionResult[SESSION_STORAGE_KEY] || null;
  let coordinatorChanged = false;
  if (session?.participant && !coordinator.participantSessionId) {
    coordinator.participantSessionId = newParticipantSessionId();
    coordinator.stateRevision += 1;
    coordinatorChanged = true;
  } else if (!session?.participant && coordinator.participantSessionId) {
    coordinator.participantSessionId = '';
    coordinator.sessionEpoch += 1;
    coordinator.stateRevision += 1;
    coordinatorChanged = true;
  }
  if (coordinatorChanged) {
    coordinator.updatedAt = new Date().toISOString();
    await chrome.storage.local.set({ [COORDINATOR_STORAGE_KEY]: coordinator });
  }
  return {
    ok: true,
    session,
    queue: queueResult[QUEUE_STORAGE_KEY] || null,
    ...coordinatorFields(coordinator),
  };
}

// Claim, step 1 (validate request): the participant record and claim token are checked before any store is read.
function clientSessionClaim(message) {
  const participant = participantValue(message.participant);
  const requestedToken = message.claimToken || message.participantSessionId;
  return {
    participant,
    claimToken: requestedToken ? validCoordinatorId(requestedToken) : newParticipantSessionId(),
  };
}

// Claim, step 2a (validate against a held claim): only an identical retry with the same token succeeds.
function repeatedClaimResponse(coordinator, currentSession, claim) {
  if (coordinator.participantSessionId === claim.claimToken && currentSession.participant) {
    if (!sameValue(currentSession.participant, claim.participant)) {
      throw coordinatorError(
        'This claim token already belongs to different client data. Use the participant update operation.',
        'CLIENT_SESSION_CLAIMED',
        coordinator,
      );
    }
    return { ok: true, claimed: false, idempotent: true, ...coordinatorFields(coordinator) };
  }
  throw coordinatorError(
    'Another assistant window already claimed this browser client session.',
    'CLIENT_SESSION_CLAIMED',
    coordinator,
  );
}

// Claim, step 2b (validate a new claim): current epoch and state, and no different client already loaded.
function assertClaimAllowed(message, coordinator, currentSession, participant) {
  assertCoordinatorEpoch(message, coordinator);
  assertStateRevision(message, coordinator);
  if (currentSession.participant && !sameValue(currentSession.participant, participant)) {
    throw coordinatorError(
      'A client is already loaded. Start over before selecting a different client.',
      'CLIENT_SESSION_CLAIMED',
      coordinator,
    );
  }
}

// Claim, step 3 (merge): a claim opens a new epoch and restarts every stored application's counters.
function bindClaimedSession(coordinator, applicationIds, claimToken, claimedAt) {
  applicationIds.forEach((id) => {
    coordinator.applicationGenerations[id] = 0;
    coordinator.applicationRevisions[id] = 0;
  });
  coordinator.sessionEpoch += 1;
  coordinator.participantSessionId = claimToken;
  coordinator.stateRevision += 1;
  coordinator.updatedAt = claimedAt;
}

// Claim, step 3 (merge): stored applications were filled from earlier client data and must be verified again.
function sourceReloadedApplications(existingApps, durableQueue, claimedAt) {
  const sourceReloadOptions = {
    status: 'source_expired',
    checkpointKind: 'source_expired',
    checkpointLabel: 'Verify reloaded client data before resuming',
    updatedAt: claimedAt,
  };
  return {
    apps: existingApps.map((application) => revokedApplication(application, sourceReloadOptions)),
    queue: workQueueEngine.buildQueue(
      (durableQueue?.applications || []).map((application) => revokedApplication(application, sourceReloadOptions)),
      durableQueue?.audit || [],
    ),
  };
}

// Claim, step 4 (persist): participant, reloaded applications, and coordinator land together; old leases are dropped.
async function writeClaimedSession(coordinator, participant, reloaded) {
  await Promise.all([
    chrome.storage.session.set({
      [SESSION_STORAGE_KEY]: { participant, apps: reloaded.apps, currentAppId: null },
    }),
    chrome.storage.local.set({
      [COORDINATOR_STORAGE_KEY]: coordinator,
      [QUEUE_STORAGE_KEY]: reloaded.queue,
    }),
    chrome.storage.local.remove(LEASE_STORAGE_KEY),
  ]);
}

async function claimClientSession(message) {
  const claim = clientSessionClaim(message);
  const [coordinator, sessionResult, queueResult] = await Promise.all([
    coordinatorState(),
    chrome.storage.session.get(SESSION_STORAGE_KEY),
    chrome.storage.local.get(QUEUE_STORAGE_KEY),
  ]);
  const currentSession = sessionResult[SESSION_STORAGE_KEY] || {};
  if (coordinator.participantSessionId) return repeatedClaimResponse(coordinator, currentSession, claim);
  assertClaimAllowed(message, coordinator, currentSession, claim.participant);

  const durableQueue = queueResult[QUEUE_STORAGE_KEY];
  const existingApps = currentSession.apps || [];
  const existingIds = storedApplicationIds(existingApps, durableQueue?.applications);
  cancelApplicationTargets(existingIds, existingApps);
  const claimedAt = new Date().toISOString();
  bindClaimedSession(coordinator, existingIds, claim.claimToken, claimedAt);
  const reloaded = sourceReloadedApplications(existingApps, durableQueue, claimedAt);
  await writeClaimedSession(coordinator, claim.participant, reloaded);
  return { ok: true, claimed: true, idempotent: false, ...coordinatorFields(coordinator) };
}

async function updateSessionParticipant(message) {
  const participant = participantValue(message.participant);
  let [coordinator, sessionResult, queueResult] = await Promise.all([
    coordinatorState(),
    chrome.storage.session.get(SESSION_STORAGE_KEY),
    chrome.storage.local.get(QUEUE_STORAGE_KEY),
  ]);
  assertCoordinatorEpoch(message, coordinator);
  assertParticipantSession(message, coordinator);
  assertStateRevision(message, coordinator);
  let session = sessionResult[SESSION_STORAGE_KEY] || {};
  if (sameValue(session.participant, participant)) {
    return { ok: true, updated: false, revokedApplicationIds: [], ...coordinatorFields(coordinator) };
  }

  const ids = storedApplicationIds(session.apps, queueResult[QUEUE_STORAGE_KEY]?.applications);
  if (ids.length) {
    const revoked = await revokeApplications({
      applicationIds: ids,
      status: 'paused',
      checkpointKind: 'source_stale',
      checkpointLabel: 'Client data changed; verify before resuming',
    });
    coordinator = revoked.coordinator;
    session = revoked.session;
  }
  session.participant = participant;
  coordinator.stateRevision += 1;
  coordinator.updatedAt = new Date().toISOString();
  await Promise.all([
    chrome.storage.session.set({ [SESSION_STORAGE_KEY]: session }),
    chrome.storage.local.set({ [COORDINATOR_STORAGE_KEY]: coordinator }),
  ]);
  return { ok: true, updated: true, revokedApplicationIds: ids, ...coordinatorFields(coordinator) };
}

// Persist, step 1 (validate request): the incoming snapshot is normalized before any store is read.
function incomingAssistantState(message) {
  return {
    session: message.session && typeof message.session === 'object' ? message.session : {},
    queue: workQueueEngine.buildQueue(message.queue?.applications || [], message.queue?.audit || []),
  };
}

// Persist, step 2 (validate applications): only applications whose content differs from the stored copy are written.
function changedApplicationIdsFor(stored, incoming) {
  const currentSessionApps = applicationsById(stored.session.apps);
  const incomingSessionApps = applicationsById(incoming.session.apps);
  const currentQueueApps = applicationsById(stored.queue.applications);
  const incomingQueueApps = applicationsById(incoming.queue.applications);
  const allIncomingIds = [...new Set([
    ...incomingSessionApps.keys(),
    ...incomingQueueApps.keys(),
  ].filter(Boolean).map(validCoordinatorId))];
  return new Set(allIncomingIds.filter((id) => applicationChanged(
    currentSessionApps.get(id) || currentQueueApps.get(id) || null,
    incomingSessionApps.get(id) || incomingQueueApps.get(id) || null,
  )));
}

// Persist, step 2 (validate applications): each changed application must carry its current generation and
// revision and must not be leased to another window. Expired leases on changed applications are dropped.
function authorizeChangedApplications(message, stored, changedApplicationIds) {
  const { coordinator, leases } = stored;
  const holder = String(message.holder || message.workerId || '');
  let expiredLeaseRemoved = false;
  changedApplicationIds.forEach((id) => {
    if (!Object.hasOwn(coordinator.applicationGenerations, id)) coordinator.applicationGenerations[id] = 0;
    if (!Object.hasOwn(coordinator.applicationRevisions, id)) coordinator.applicationRevisions[id] = 0;
    assertApplicationGeneration(message, coordinator, id);
    assertApplicationRevision(message, coordinator, id);
    if (leases[id] && !activeLease(leases[id])) {
      delete leases[id];
      expiredLeaseRemoved = true;
    } else {
      assertLeaseNotHeldByOther(leases[id], holder, coordinator, id);
    }
  });
  return expiredLeaseRemoved;
}

// Persist, step 3 (merge): changed applications replace their stored copies; the participant always stays the claimed one.
function mergeAssistantState(stored, incoming, changedApplicationIds) {
  const nextSessionApps = replaceApplications(stored.session.apps, incoming.session.apps, changedApplicationIds);
  const nextQueueApps = replaceApplications(stored.queue.applications, incoming.queue.applications, changedApplicationIds);
  const nextAudit = mergeAudit(stored.queue.audit, incoming.queue.audit);
  const mergedSession = {
    participant: stored.session.participant ?? null,
    apps: nextSessionApps,
    currentAppId: Object.hasOwn(incoming.session, 'currentAppId') ? incoming.session.currentAppId : stored.session.currentAppId || null,
  };
  const mergedQueue = workQueueEngine.buildQueue(
    nextQueueApps,
    nextAudit,
  );
  return { mergedSession, mergedQueue, nextAudit };
}

// Persist, step 3 (merge): changed applications advance their revisions; any visible change advances the state revision.
function recordPersistedChanges(stored, merged, changedApplicationIds) {
  const { coordinator, session, queue } = stored;
  const sessionMetadataChanged = merged.mergedSession.currentAppId !== (session.currentAppId || null);
  const auditChanged = !sameValue(queue.audit || [], merged.nextAudit);
  const stateChanged = changedApplicationIds.size > 0 || sessionMetadataChanged || auditChanged;
  changedApplicationIds.forEach((id) => {
    coordinator.applicationRevisions[id] = normalizedGeneration(coordinator.applicationRevisions[id]) + 1;
  });
  if (stateChanged) {
    coordinator.stateRevision += 1;
    coordinator.updatedAt = new Date().toISOString();
  }
  return stateChanged;
}

// Persist, step 4 (persist): session, queue, and coordinator are written together, or only the lease cleanup
// when nothing visible changed.
async function writePersistedState(stored, merged, { stateChanged, expiredLeaseRemoved }) {
  const { coordinator, leases } = stored;
  const { mergedSession, mergedQueue } = merged;
  const writes = [];
  if (stateChanged) {
    writes.push(
      chrome.storage.session.set({ [SESSION_STORAGE_KEY]: mergedSession }),
      chrome.storage.local.set({
        [QUEUE_STORAGE_KEY]: mergedQueue,
        [COORDINATOR_STORAGE_KEY]: coordinator,
        ...(expiredLeaseRemoved ? { [LEASE_STORAGE_KEY]: leases } : {}),
      }),
    );
  } else if (expiredLeaseRemoved) {
    writes.push(chrome.storage.local.set({ [LEASE_STORAGE_KEY]: leases }));
  }
  if (writes.length) await Promise.all(writes);
}

async function persistAssistantState(message) {
  const incoming = incomingAssistantState(message);
  const stored = await readCoordinatedState();
  assertCoordinatorEpoch(message, stored.coordinator);
  assertParticipantSession(message, stored.coordinator);
  assertStateRevision(message, stored.coordinator);

  const changedApplicationIds = changedApplicationIdsFor(stored, incoming);
  const expiredLeaseRemoved = authorizeChangedApplications(message, stored, changedApplicationIds);
  const merged = mergeAssistantState(stored, incoming, changedApplicationIds);
  const stateChanged = recordPersistedChanges(stored, merged, changedApplicationIds);
  await writePersistedState(stored, merged, { stateChanged, expiredLeaseRemoved });
  return {
    ok: true,
    persisted: stateChanged,
    changedApplicationIds: [...changedApplicationIds],
    participantIgnored: Object.hasOwn(incoming.session, 'participant')
      && !sameValue(incoming.session.participant, stored.session.participant),
    ...coordinatorFields(stored.coordinator),
  };
}

async function clearAssistantState(message) {
  const [coordinator, sessionResult] = await Promise.all([
    coordinatorState(),
    chrome.storage.session.get(SESSION_STORAGE_KEY),
  ]);
  assertCoordinatorEpoch(message, coordinator);
  cancelApplicationTargets(
    (sessionResult[SESSION_STORAGE_KEY]?.apps || []).map((application) => application.id),
    sessionResult[SESSION_STORAGE_KEY]?.apps || [],
  );
  coordinator.sessionEpoch += 1;
  coordinator.participantSessionId = '';
  coordinator.applicationGenerations = {};
  coordinator.applicationRevisions = {};
  coordinator.stateRevision += 1;
  coordinator.updatedAt = new Date().toISOString();
  await Promise.all([
    chrome.storage.session.remove(SESSION_STORAGE_KEY),
    chrome.storage.local.remove(QUEUE_STORAGE_KEY),
    chrome.storage.local.remove(LEASE_STORAGE_KEY),
    chrome.storage.local.set({ [COORDINATOR_STORAGE_KEY]: coordinator }),
  ]);
  return { ok: true, cleared: true, ...coordinatorFields(coordinator) };
}

function handleGetAssistantState(_message, _sender, sendResponse) {
  return respondCoordinated(() => getAssistantState(), sendResponse);
}

function handleClaimClientSession(message, _sender, sendResponse) {
  return respondCoordinated(() => claimClientSession(message), sendResponse);
}

function handleUpdateSessionParticipant(message, _sender, sendResponse) {
  return respondCoordinated(() => updateSessionParticipant(message), sendResponse);
}

function handlePersistAssistantState(message, _sender, sendResponse) {
  return respondCoordinated(() => persistAssistantState(message), sendResponse);
}

function handleClearAssistantState(message, _sender, sendResponse) {
  return respondCoordinated(() => clearAssistantState(message), sendResponse);
}

// Returns the handler's answer to Chrome (true = response pending), or undefined for a type this router does not own.
function routeSessionMessage(message, sender, sendResponse) {
  if (message?.type === 'GET_ASSISTANT_STATE') return handleGetAssistantState(message, sender, sendResponse);
  if (message?.type === 'CLAIM_CLIENT_SESSION') return handleClaimClientSession(message, sender, sendResponse);
  if (message?.type === 'UPDATE_SESSION_PARTICIPANT') return handleUpdateSessionParticipant(message, sender, sendResponse);
  if (message?.type === 'PERSIST_ASSISTANT_STATE') return handlePersistAssistantState(message, sender, sendResponse);
  if (message?.type === 'CLEAR_ASSISTANT_STATE') return handleClearAssistantState(message, sender, sendResponse);
  return undefined;
}

// ---------------------------------------------------------------------------
// Application run handlers: run revocation and checks, write leases, document-bound tab commands, and the
// pause that follows when an application's tab closes.
// ---------------------------------------------------------------------------

async function closeApplicationTab(tabId) {
  const [localResult, sessionResult, leaseResult, coordinator] = await Promise.all([
    chrome.storage.local.get(QUEUE_STORAGE_KEY),
    chrome.storage.session.get(SESSION_STORAGE_KEY),
    chrome.storage.local.get(LEASE_STORAGE_KEY),
    coordinatorState(),
  ]);
  const queue = localResult[QUEUE_STORAGE_KEY];
  const session = sessionResult[SESSION_STORAGE_KEY];
  const affectedIds = [...new Set([
    ...(queue?.applications || [])
      .filter((application) => application.tabId === tabId)
      .map((application) => application.id),
    ...(session?.apps || [])
      .filter((application) => application.tabId === tabId)
      .map((application) => application.id),
  ])];
  if (affectedIds.length) {
    if (queue) await chrome.storage.local.set({ [QUEUE_STORAGE_KEY]: workQueueEngine.markTabClosed(queue, tabId) });
    const leases = { ...(leaseResult[LEASE_STORAGE_KEY] || {}) };
    affectedIds.forEach((id) => {
      delete leases[id];
      invalidateApplicationRun(coordinator, id);
    });
    coordinator.stateRevision += 1;
    coordinator.updatedAt = new Date().toISOString();
    await chrome.storage.local.set({
      [LEASE_STORAGE_KEY]: leases,
      [COORDINATOR_STORAGE_KEY]: coordinator,
    });
  }
  if (session?.apps?.some((application) => application.tabId === tabId)) {
    const updatedAt = new Date().toISOString();
    session.apps = session.apps.map((application) => application.tabId === tabId ? {
      ...application,
      tabId: null,
      status: application.status === 'ready_for_review' ? application.status : 'paused',
      checkpoint: { kind: 'tab_closed', label: 'Application tab closed', createdAt: updatedAt },
      lease: null,
      updatedAt,
    } : application);
    await chrome.storage.session.set({ [SESSION_STORAGE_KEY]: session });
  }
}

async function revokeApplicationRun(message) {
  const applicationId = validCoordinatorId(message.applicationId);
  const coordinator = await coordinatorState();
  assertCurrentApplicationRun(message, coordinator, applicationId);
  const result = await revokeApplications({
    applicationIds: [applicationId],
    status: 'paused',
    checkpointKind: 'voluntary_pause',
    checkpointLabel: 'Paused by caseworker',
  });
  return {
    ok: true,
    applicationGeneration: result.coordinator.applicationGenerations[applicationId],
    applicationRevision: result.coordinator.applicationRevisions[applicationId],
    ...coordinatorFields(result.coordinator),
  };
}

async function checkApplicationRun(message) {
  const applicationId = validCoordinatorId(message.applicationId);
  const coordinator = await coordinatorState();
  const { applicationGeneration, applicationRevision } = assertCurrentApplicationRun(message, coordinator, applicationId);
  if (message.requireLease) {
    const holder = validCoordinatorId(message.holder);
    const result = await chrome.storage.local.get(LEASE_STORAGE_KEY);
    const lease = result[LEASE_STORAGE_KEY]?.[applicationId];
    if (!lease || lease.holder !== holder || Date.parse(lease.expiresAt) <= Date.now()) {
      throw coordinatorError(
        'This application run no longer owns the write lease.',
        'LEASE_LOST',
        coordinator,
        { applicationId },
      );
    }
  }
  return { ok: true, allowed: true, applicationGeneration, applicationRevision, ...coordinatorFields(coordinator) };
}

// Command, step 1 (validate request): a known command bound to one tab, one document, and its route policy.
function validatedApplicationCommand(message) {
  const applicationId = validCoordinatorId(message.applicationId);
  const tabId = Number(message.tabId);
  const documentId = String(message.documentId || '');
  const command = message.command && typeof message.command === 'object' ? structuredClone(message.command) : null;
  if (!Number.isInteger(tabId) || tabId < 0) throw new Error('A valid application tab is required.');
  if (!documentId) throw new Error('A bound application document is required.');
  if (!APPLICATION_COMMAND_TYPES.has(command?.type)) throw new Error('Unsupported application command.');
  if (!command.routePolicy || typeof command.routePolicy !== 'object') throw new Error('The application command is missing its bound route policy.');
  return { applicationId, tabId, documentId, command };
}

// Command, step 2 (validate target): the command may only reach the tab saved for this application.
function assertBoundApplicationTab(session, coordinator, applicationId, tabId) {
  const savedApplication = (session?.apps || [])
    .find((application) => application.id === applicationId);
  if (!savedApplication || !Number.isInteger(savedApplication.tabId) || savedApplication.tabId !== tabId) {
    throw coordinatorError(
      'The command target no longer matches the saved application tab.',
      'APPLICATION_TAB_MISMATCH',
      coordinator,
      { applicationId },
    );
  }
}

// Command, step 3 (lease): a write command extends the holder's lease for the length of the command.
async function extendCommandLease(message, coordinator, leaseResult, applicationId) {
  const holder = validCoordinatorId(message.holder);
  const leases = { ...(leaseResult[LEASE_STORAGE_KEY] || {}) };
  const lease = assertActiveLeaseHolder(leases[applicationId], holder, coordinator, applicationId);
  leases[applicationId] = {
    ...lease,
    expiresAt: new Date(Date.now() + COMMAND_LEASE_MS).toISOString(),
  };
  await chrome.storage.local.set({ [LEASE_STORAGE_KEY]: leases });
}

// Command, step 4 (dispatch): the target stays registered for cancellation until the tab answers.
function dispatchApplicationCommand(applicationId, target, command) {
  const unregister = registerCommandTarget(applicationId, target);
  let dispatch;
  try {
    dispatch = Promise.resolve(chrome.tabs.sendMessage(target.tabId, command, { documentId: target.documentId }));
  } catch (error) {
    unregister();
    throw error;
  }
  return dispatch.finally(unregister);
}

// Runs on the coordinator chain: validates, extends the lease, and starts the dispatch without awaiting the tab.
async function startApplicationCommand(message) {
  const { applicationId, tabId, documentId, command } = validatedApplicationCommand(message);
  const [coordinator, leaseResult, sessionResult] = await Promise.all([
    coordinatorState(),
    chrome.storage.local.get(LEASE_STORAGE_KEY),
    chrome.storage.session.get(SESSION_STORAGE_KEY),
  ]);
  const { applicationGeneration, applicationRevision } = assertCurrentApplicationRun(message, coordinator, applicationId);
  assertBoundApplicationTab(sessionResult[SESSION_STORAGE_KEY], coordinator, applicationId, tabId);
  const requireLease = WRITE_COMMAND_TYPES.has(command.type) || Boolean(message.requireLease);
  if (requireLease) await extendCommandLease(message, coordinator, leaseResult, applicationId);
  return {
    applicationId,
    applicationGeneration,
    applicationRevision,
    requireLease,
    holder: message.holder,
    dispatch: dispatchApplicationCommand(applicationId, { tabId, documentId }, command),
    coordinator: coordinatorFields(coordinator),
  };
}

function commandDispatchFailure(error, started) {
  return {
    ok: false,
    dispatched: true,
    stale: false,
    code: 'TAB_COMMAND_FAILED',
    error: error?.message || 'The application tab rejected the command.',
    ...started.coordinator,
  };
}

// Runs on the coordinator chain after the tab answers: the result only counts if nothing revoked the run meanwhile.
async function authorizeCommandResult(started) {
  const coordinator = await coordinatorState();
  assertCoordinatorEpoch({ sessionEpoch: started.coordinator.sessionEpoch }, coordinator);
  assertApplicationGeneration(
    { applicationGeneration: started.applicationGeneration },
    coordinator,
    started.applicationId,
  );
  assertApplicationRevision(
    { applicationRevision: started.applicationRevision },
    coordinator,
    started.applicationId,
  );
  if (started.requireLease) {
    const leaseResult = await chrome.storage.local.get(LEASE_STORAGE_KEY);
    assertActiveLeaseHolder(leaseResult[LEASE_STORAGE_KEY]?.[started.applicationId], started.holder, coordinator, started.applicationId);
    await shortenCommandLease(started.applicationId, started.holder);
  }
  return coordinatorFields(coordinator);
}

// Command, step 5 (respond): waits for the tab off the coordinator chain, then re-authorizes on it.
async function finishApplicationCommand(started) {
  let result;
  try {
    result = await started.dispatch;
  } catch (error) {
    await coordinate(() => shortenCommandLease(started.applicationId, started.holder));
    return commandDispatchFailure(error, started);
  }

  try {
    const authorization = await coordinate(() => authorizeCommandResult(started));
    return { ...result, dispatched: true, ...authorization };
  } catch (error) {
    return coordinationError(error, { dispatched: true });
  }
}

async function acquireApplicationLease(message) {
  const applicationId = validCoordinatorId(message.applicationId);
  const holder = validCoordinatorId(message.holder);
  const [coordinator, result] = await Promise.all([
    coordinatorState(),
    chrome.storage.local.get(LEASE_STORAGE_KEY),
  ]);
  const { applicationGeneration, applicationRevision } = assertCurrentApplicationRun(message, coordinator, applicationId);
  const leases = { ...(result[LEASE_STORAGE_KEY] || {}) };
  const decision = workQueueEngine.acquireLease({ lease: leases[applicationId] || null }, holder, { leaseMs: message.leaseMs });
  if (!decision.allowed) return { ok: false, ...decision, ...coordinatorFields(coordinator) };
  leases[applicationId] = decision.lease;
  await chrome.storage.local.set({ [LEASE_STORAGE_KEY]: leases });
  return { ok: true, allowed: true, lease: decision.lease, applicationGeneration, applicationRevision, ...coordinatorFields(coordinator) };
}

async function releaseApplicationLease(message) {
  const applicationId = validCoordinatorId(message.applicationId);
  const holder = validCoordinatorId(message.holder);
  const [coordinator, result] = await Promise.all([
    coordinatorState(),
    chrome.storage.local.get(LEASE_STORAGE_KEY),
  ]);
  const { applicationGeneration, applicationRevision } = assertCurrentApplicationRun(message, coordinator, applicationId);
  const leases = { ...(result[LEASE_STORAGE_KEY] || {}) };
  assertLeaseNotHeldByOther(leases[applicationId], holder, coordinator, applicationId);
  delete leases[applicationId];
  await chrome.storage.local.set({ [LEASE_STORAGE_KEY]: leases });
  return { ok: true, lease: leases[applicationId] || null, applicationGeneration, applicationRevision, ...coordinatorFields(coordinator) };
}

function handleRevokeApplicationRun(message, _sender, sendResponse) {
  return respondCoordinated(() => revokeApplicationRun(message), sendResponse);
}

function handleCheckApplicationRun(message, _sender, sendResponse) {
  return respondCoordinated(() => checkApplicationRun(message), sendResponse, { allowed: false });
}

function handleExecuteApplicationCommand(message, _sender, sendResponse) {
  coordinate(() => startApplicationCommand(message))
    .then(finishApplicationCommand)
    .then(sendResponse)
    .catch((error) => sendResponse(coordinationError(error, { dispatched: false })));
  return true;
}

function handleAcquireApplicationLease(message, _sender, sendResponse) {
  return respondCoordinated(() => acquireApplicationLease(message), sendResponse, { allowed: false });
}

function handleReleaseApplicationLease(message, _sender, sendResponse) {
  return respondCoordinated(() => releaseApplicationLease(message), sendResponse);
}

// Returns the handler's answer to Chrome (true = response pending), or undefined for a type this router does not own.
function routeApplicationRunMessage(message, sender, sendResponse) {
  if (message?.type === 'REVOKE_APPLICATION_RUN') return handleRevokeApplicationRun(message, sender, sendResponse);
  if (message?.type === 'CHECK_APPLICATION_RUN') return handleCheckApplicationRun(message, sender, sendResponse);
  if (message?.type === 'EXECUTE_APPLICATION_COMMAND') return handleExecuteApplicationCommand(message, sender, sendResponse);
  if (message?.type === 'ACQUIRE_APPLICATION_LEASE') return handleAcquireApplicationLease(message, sender, sendResponse);
  if (message?.type === 'RELEASE_APPLICATION_LEASE') return handleReleaseApplicationLease(message, sender, sendResponse);
  return undefined;
}

// ---------------------------------------------------------------------------
// Connector client and demo connector: read-only requests to the managed connector service, bundled fictional
// records when none is configured, and the connector-change rule that expires connector-derived client data.
// ---------------------------------------------------------------------------

const DEMO_RECORDS = [
  {
    record_id: '339619',
    participant: {
      name: { first: 'Celeste', middle: 'NAVA', last: 'Thomas', suffix: 'II' },
      date_of_birth: '2000-01-02',
      ethnicity: 'Hispanic/Latino',
      gender: 'Female',
      primary_language: 'English',
      special_needs: false,
      marital_status: 'Single parent household',
      farm_worker: false,
      pregnant: false,
      housing_status: 'Stable housing',
      ssn: '123-45-6789',
    },
    contact_information: {
      preferred_method: 'Email',
      phones: { cell: '777-777-7777' },
      email: 'testnava@email.com',
    },
    address: {
      residential: {
        street: '5556 Test Blvd',
        unit: 'Apt 556',
        city: 'WILDOMAR',
        state: 'California',
        county: 'Riverside',
        zip: '92595',
        country: 'United States',
      },
      mailing: {
        street: '5556 Test Blvd',
        unit: 'Apt 556',
        city: 'WILDOMAR',
        state: 'California',
        county: 'Riverside',
        zip: '92595',
        country: 'United States',
      },
    },
    householdSize: '3',
    immigrationStatus: 'U.S. citizen',
    income: '1850',
    childcare: true,
    unemployment: false,
    programData: {
      ihss: {
        applyingForSelf: true,
        adoptedMinorChild: false,
        genderIdentity: 'Decline to state',
        birthSex: 'Female',
        sexualOrientation: 'Decline to state',
        veteran: false,
        receivesSsi: false,
        homeAssistanceAvailable: false,
        livesAlone: false,
        householdReceivesServices: false,
        householdMembers: [{
          relationship: 'Child',
          name: 'Jordan Testchild',
          dateOfBirth: '2018-06-15',
          ssn: '987-65-4321',
        }],
        livingArrangement: 'Independent Living',
        blind: false,
        visuallyImpaired: false,
        healthHistory: 'Needs help with bathing, dressing, meal preparation, and transportation.',
        dailyLivingLimitations: true,
        hospiceCare: false,
        terminalIllness: false,
        organTransplant: false,
        supplementalOxygen: false,
        cancerTreatment: false,
        domesticServices: true,
        personalCare: true,
        transportation: true,
        paramedicalCare: false,
        otherServices: false,
        pastIhss: false,
      },
      wic: {
        canReceiveTexts: true,
        mediCalCoverage: 'No',
        postpartum: false,
        breastfeedingInfant: false,
        formulaInfant: false,
        childUnderFive: true,
        appointmentInPerson: true,
        appointmentPhone: false,
        appointmentVideo: false,
        clinic: 'Temecula WIC',
      },
    },
  },
  {
    record_id: '338618',
    participant: {
      name: { first: 'Amelie', middle: 'NAVA', last: 'Thomas I' },
      date_of_birth: '2000-01-01',
      ethnicity: 'Hispanic/Latino',
      gender: 'Female',
      primary_language: 'English',
      special_needs: false,
      marital_status: 'Single parent household',
    },
    contact_information: {
      preferred_method: null,
      phones: { cell: '7777777777' },
      email: 'testnava@email.com',
    },
    address: {
      residential: {
        street: '5555 Test Blvd',
        unit: 'Apt 555',
        city: 'BANNING',
        state: 'CA',
        county: 'Riverside',
        zip: '92220',
      },
      mailing: {
        street: '5555 Test Blvd',
        unit: 'Apt 555',
        city: 'BANNING',
        state: 'CA',
        county: 'Riverside',
        zip: '92220',
      },
    },
  },
  {
    record_id: '339637',
    participant: {
      name: { first: 'Sawyer', middle: 'NAVA', last: 'Thomas XX' },
      date_of_birth: '1954-01-10',
      ethnicity: 'Hispanic/Latino',
      gender: 'Male',
      primary_language: 'Spanish',
      special_needs: false,
      marital_status: 'Other',
    },
    contact_information: {
      preferred_method: null,
      phones: { cell: '7777777777' },
      email: 'testnava@email.com',
    },
    address: {
      residential: {
        street: '5574 Test Blvd',
        unit: 'Apt 574',
        city: 'WILDOMAR',
        state: 'CA',
        county: 'Riverside',
        zip: '92505',
      },
      mailing: {
        street: '5574 Test Blvd',
        unit: 'Apt 574',
        city: 'WILDOMAR',
        state: 'CA',
        county: 'Riverside',
        zip: '92505',
      },
    },
  },
];

function demoConnectorStatus() {
  return {
    mode: 'demo',
    provider: 'bundled-demo-records',
    organizationName: 'Nava fictional test data',
    status: 'ready',
    message: 'Using bundled fictional records. Configure a managed connector to retrieve organization data.',
  };
}

function isoDateOffset(days, now = new Date()) {
  const base = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  base.setUTCDate(base.getUTCDate() + days);
  return base.toISOString().slice(0, 10);
}

function demoRecertifications(now = new Date()) {
  return recertificationEngine.normalizeCaseload([
    {
      id: 'demo-recert-339637-calworks', recordId: '339637', displayName: 'Sawyer Thomas XX', firstName: 'Sawyer',
      programId: 'calworks', programName: 'CalWORKs', dueDate: isoDateOffset(-3, now), preferredContact: 'Phone',
      requirements: {
        contact: { status: 'current' }, household: { status: 'confirmed' }, income: { status: 'current' },
        expenses: { status: 'confirmed' }, documents: { status: 'current' },
      },
      source: 'fictional-demo',
    },
    {
      id: 'demo-recert-339619-calfresh', recordId: '339619', displayName: 'Celeste Thomas II', firstName: 'Celeste',
      programId: 'calfresh', programName: 'CalFresh', dueDate: isoDateOffset(12, now), preferredContact: 'Email',
      requirements: {
        contact: { status: 'current' }, household: { status: 'missing' }, income: { status: 'stale' },
        expenses: { status: 'missing' }, documents: { status: 'missing' },
      },
      source: 'fictional-demo',
    },
    {
      id: 'demo-recert-338618-medical', recordId: '338618', displayName: 'Amelie Thomas I', firstName: 'Amelie',
      programId: 'medical', programName: 'Medi-Cal', dueDate: isoDateOffset(33, now), preferredContact: 'Email',
      requirements: {
        contact: { status: 'stale' }, household: { status: 'missing' }, income: { status: 'missing' },
        expenses: { status: 'missing' }, documents: { status: 'missing' },
      },
      source: 'fictional-demo',
    },
  ], { today: now });
}

function demoRecordLookup(recordId) {
  const record = DEMO_RECORDS.find((item) => item.record_id === recordId) || null;
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

// ---------------------------------------------------------------------------
// Service worker wiring: Chrome lifecycle, tab, and message listeners.
// ---------------------------------------------------------------------------

async function configureSidePanel() {
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
}

// Each message type belongs to exactly one domain router. A type no router owns gets no response.
function routeMessage(message, sender, sendResponse) {
  return routeSessionMessage(message, sender, sendResponse)
    ?? routeApplicationRunMessage(message, sender, sendResponse)
    ?? routeConnectorMessage(message, sender, sendResponse)
    ?? false;
}

chrome.runtime.onInstalled.addListener(() => {
  configureSidePanel().catch(() => undefined);
});

chrome.runtime.onStartup.addListener(() => {
  configureSidePanel().catch(() => undefined);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  coordinate(() => closeApplicationTab(tabId)).catch(() => undefined);
});

chrome.runtime.onMessage.addListener(routeMessage);
