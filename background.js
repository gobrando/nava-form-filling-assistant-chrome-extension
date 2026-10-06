// Service worker: owns the assistant coordinator core (one serialized chain over the coordinator, session, queue, and lease stores) and wires the client-session, application-run, and connector-client modules to Chrome's listeners.
import './shared/connector-engine.js';
import './shared/work-queue-engine.js';
import './shared/program-catalog.js';
import './shared/recertification-engine.js';
import './shared/demo-connector-data.js';
import './background/coordinator-rules.js';
import './background/client-session.js';
import './background/application-runs.js';
import './background/connector-client.js';

const connectorEngine = globalThis.NavaConnectorEngine;
const workQueueEngine = globalThis.NavaWorkQueueEngine;
const programCatalog = globalThis.NavaProgramCatalog;
const recertificationEngine = globalThis.NavaRecertificationEngine;
const demoConnectorData = globalThis.NavaDemoConnectorData;
const coordinatorRules = globalThis.NavaCoordinatorRules;
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
const {
  activeLease,
  coordinationError,
  invalidateApplicationRun,
  normalizeCoordinator,
  revokedApplication,
  validCoordinatorId,
} = coordinatorRules;

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
// Service-worker modules: each one receives the coordinator core and the shared engines from here, so every
// coordinated operation runs on the one chain above.
// ---------------------------------------------------------------------------

const storageKeys = {
  CONNECTOR_STORAGE_KEY,
  QUEUE_STORAGE_KEY,
  LEASE_STORAGE_KEY,
  SESSION_STORAGE_KEY,
  COORDINATOR_STORAGE_KEY,
};

const { routeSessionMessage } = globalThis.NavaClientSession.create({
  rules: coordinatorRules,
  workQueueEngine,
  storageKeys,
  coordinatorState,
  readCoordinatedState,
  revokeApplications,
  cancelApplicationTargets,
  respondCoordinated,
});

const { closeApplicationTab, routeApplicationRunMessage } = globalThis.NavaApplicationRuns.create({
  rules: coordinatorRules,
  workQueueEngine,
  storageKeys,
  APPLICATION_COMMAND_TYPES,
  WRITE_COMMAND_TYPES,
  COMMAND_LEASE_MS,
  coordinate,
  coordinatorState,
  revokeApplications,
  registerCommandTarget,
  shortenCommandLease,
  respondCoordinated,
});

const { routeConnectorMessage } = globalThis.NavaConnectorClient.create({
  rules: coordinatorRules,
  connectorEngine,
  programCatalog,
  recertificationEngine,
  demoConnectorData,
  storageKeys,
  coordinatorState,
  revokeApplications,
  respondCoordinated,
});

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
