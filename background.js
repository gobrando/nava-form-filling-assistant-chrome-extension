import './shared/connector-engine.js';
import './shared/work-queue-engine.js';
import './shared/program-catalog.js';

const connectorEngine = globalThis.NavaConnectorEngine;
const workQueueEngine = globalThis.NavaWorkQueueEngine;
const programCatalog = globalThis.NavaProgramCatalog;
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

function coordinate(operation) {
  const next = coordinatorChain.catch(() => {}).then(operation);
  coordinatorChain = next;
  return next;
}

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

async function coordinatorState() {
  const result = await chrome.storage.local.get(COORDINATOR_STORAGE_KEY);
  const coordinator = normalizeCoordinator(result[COORDINATOR_STORAGE_KEY]);
  if (!result[COORDINATOR_STORAGE_KEY]) {
    await chrome.storage.local.set({ [COORDINATOR_STORAGE_KEY]: coordinator });
  }
  return coordinator;
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

function activeLease(lease, now = Date.now()) {
  return Boolean(lease?.holder && Number.isFinite(Date.parse(lease.expiresAt)) && Date.parse(lease.expiresAt) > now);
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

async function revokeApplications({ applicationIds, status, checkpointKind, checkpointLabel }) {
  const ids = [...new Set((applicationIds || []).map(validCoordinatorId))];
  const updatedAt = new Date().toISOString();
  const [coordinator, sessionResult, queueResult, leaseResult] = await Promise.all([
    coordinatorState(),
    chrome.storage.session.get(SESSION_STORAGE_KEY),
    chrome.storage.local.get(QUEUE_STORAGE_KEY),
    chrome.storage.local.get(LEASE_STORAGE_KEY),
  ]);
  const session = sessionResult[SESSION_STORAGE_KEY] || {};
  const queue = queueResult[QUEUE_STORAGE_KEY] || { applications: [], audit: [] };
  const leases = { ...(leaseResult[LEASE_STORAGE_KEY] || {}) };
  ids.forEach((id) => {
    coordinator.applicationGenerations[id] = normalizedGeneration(coordinator.applicationGenerations[id]) + 1;
    coordinator.applicationRevisions[id] = normalizedGeneration(coordinator.applicationRevisions[id]) + 1;
    delete leases[id];
  });
  cancelApplicationTargets(ids, session.apps || []);
  coordinator.stateRevision += 1;
  coordinator.updatedAt = updatedAt;
  const options = { status, checkpointKind, checkpointLabel, updatedAt };
  const nextSession = {
    ...session,
    apps: (session.apps || []).map((application) => ids.includes(application.id) ? revokedApplication(application, options) : application),
  };
  const nextQueue = workQueueEngine.buildQueue(
    (queue.applications || []).map((application) => ids.includes(application.id) ? revokedApplication(application, options) : application),
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

async function invalidateConnectorParticipant() {
  const [sessionResult, queueResult] = await Promise.all([
    chrome.storage.session.get(SESSION_STORAGE_KEY),
    chrome.storage.local.get(QUEUE_STORAGE_KEY),
  ]);
  const session = sessionResult[SESSION_STORAGE_KEY] || {};
  if (!session.participant?._connector) return { invalidated: false, coordinator: await coordinatorState() };
  const ids = [...new Set([
    ...(session.apps || []).map((application) => application.id),
    ...((queueResult[QUEUE_STORAGE_KEY]?.applications || []).map((application) => application.id)),
  ].filter(Boolean))];
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

async function configureSidePanel() {
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
}

chrome.runtime.onInstalled.addListener(() => {
  configureSidePanel().catch(() => undefined);
});

chrome.runtime.onStartup.addListener(() => {
  configureSidePanel().catch(() => undefined);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  coordinate(async () => {
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
        coordinator.applicationGenerations[id] = normalizedGeneration(coordinator.applicationGenerations[id]) + 1;
        coordinator.applicationRevisions[id] = normalizedGeneration(coordinator.applicationRevisions[id]) + 1;
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
  }).catch(() => undefined);
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'GET_ASSISTANT_STATE') {
    coordinate(async () => {
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
    })
      .then(sendResponse)
      .catch((error) => sendResponse(coordinationError(error)));
    return true;
  }

  if (message?.type === 'CLAIM_CLIENT_SESSION') {
    coordinate(async () => {
      const participant = participantValue(message.participant);
      const requestedToken = message.claimToken || message.participantSessionId;
      const claimToken = requestedToken ? validCoordinatorId(requestedToken) : newParticipantSessionId();
      const [coordinator, sessionResult, queueResult] = await Promise.all([
        coordinatorState(),
        chrome.storage.session.get(SESSION_STORAGE_KEY),
        chrome.storage.local.get(QUEUE_STORAGE_KEY),
      ]);
      const currentSession = sessionResult[SESSION_STORAGE_KEY] || {};

      if (coordinator.participantSessionId) {
        if (coordinator.participantSessionId === claimToken && currentSession.participant) {
          if (!sameValue(currentSession.participant, participant)) {
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

      assertCoordinatorEpoch(message, coordinator);
      assertStateRevision(message, coordinator);
      if (currentSession.participant && !sameValue(currentSession.participant, participant)) {
        throw coordinatorError(
          'A client is already loaded. Start over before selecting a different client.',
          'CLIENT_SESSION_CLAIMED',
          coordinator,
        );
      }

      const durableApps = queueResult[QUEUE_STORAGE_KEY]?.applications || [];
      const existingApps = currentSession.apps || [];
      const existingIds = [...new Set([
        ...existingApps.map((application) => application.id),
        ...durableApps.map((application) => application.id),
      ].filter(Boolean))];
      cancelApplicationTargets(existingIds, existingApps);
      const claimedAt = new Date().toISOString();
      const sourceReloadOptions = {
        status: 'source_expired',
        checkpointKind: 'source_expired',
        checkpointLabel: 'Verify reloaded client data before resuming',
        updatedAt: claimedAt,
      };
      existingIds.forEach((id) => {
        coordinator.applicationGenerations[id] = 0;
        coordinator.applicationRevisions[id] = 0;
      });
      coordinator.sessionEpoch += 1;
      coordinator.participantSessionId = claimToken;
      coordinator.stateRevision += 1;
      coordinator.updatedAt = claimedAt;
      const nextSessionApps = existingApps.map((application) => revokedApplication(application, sourceReloadOptions));
      const nextQueue = workQueueEngine.buildQueue(
        durableApps.map((application) => revokedApplication(application, sourceReloadOptions)),
        queueResult[QUEUE_STORAGE_KEY]?.audit || [],
      );
      await Promise.all([
        chrome.storage.session.set({
          [SESSION_STORAGE_KEY]: { participant, apps: nextSessionApps, currentAppId: null },
        }),
        chrome.storage.local.set({
          [COORDINATOR_STORAGE_KEY]: coordinator,
          [QUEUE_STORAGE_KEY]: nextQueue,
        }),
        chrome.storage.local.remove(LEASE_STORAGE_KEY),
      ]);
      return { ok: true, claimed: true, idempotent: false, ...coordinatorFields(coordinator) };
    })
      .then(sendResponse)
      .catch((error) => sendResponse(coordinationError(error)));
    return true;
  }

  if (message?.type === 'UPDATE_SESSION_PARTICIPANT') {
    coordinate(async () => {
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

      const ids = [...new Set([
        ...(session.apps || []).map((application) => application.id),
        ...((queueResult[QUEUE_STORAGE_KEY]?.applications || []).map((application) => application.id)),
      ].filter(Boolean))];
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
    })
      .then(sendResponse)
      .catch((error) => sendResponse(coordinationError(error)));
    return true;
  }

  if (message?.type === 'PERSIST_ASSISTANT_STATE') {
    coordinate(async () => {
      const incomingSession = message.session && typeof message.session === 'object' ? message.session : {};
      const incomingQueue = workQueueEngine.buildQueue(message.queue?.applications || [], message.queue?.audit || []);
      const [coordinator, sessionResult, queueResult, leaseResult] = await Promise.all([
        coordinatorState(),
        chrome.storage.session.get(SESSION_STORAGE_KEY),
        chrome.storage.local.get(QUEUE_STORAGE_KEY),
        chrome.storage.local.get(LEASE_STORAGE_KEY),
      ]);
      assertCoordinatorEpoch(message, coordinator);
      assertParticipantSession(message, coordinator);
      assertStateRevision(message, coordinator);

      const currentSession = sessionResult[SESSION_STORAGE_KEY] || {};
      const currentQueue = queueResult[QUEUE_STORAGE_KEY] || { applications: [], audit: [] };
      const currentSessionApps = applicationsById(currentSession.apps);
      const incomingSessionApps = applicationsById(incomingSession.apps);
      const currentQueueApps = applicationsById(currentQueue.applications);
      const incomingQueueApps = applicationsById(incomingQueue.applications);
      const allIncomingIds = [...new Set([
        ...incomingSessionApps.keys(),
        ...incomingQueueApps.keys(),
      ].filter(Boolean).map(validCoordinatorId))];

      const changedApplicationIds = new Set();
      allIncomingIds.forEach((id) => {
        const current = currentSessionApps.get(id) || currentQueueApps.get(id) || null;
        const incoming = incomingSessionApps.get(id) || incomingQueueApps.get(id) || null;
        if (applicationChanged(current, incoming)) changedApplicationIds.add(id);
      });

      const leases = { ...(leaseResult[LEASE_STORAGE_KEY] || {}) };
      let expiredLeaseRemoved = false;
      changedApplicationIds.forEach((id) => {
        if (!Object.hasOwn(coordinator.applicationGenerations, id)) {
          coordinator.applicationGenerations[id] = 0;
        }
        if (!Object.hasOwn(coordinator.applicationRevisions, id)) {
          coordinator.applicationRevisions[id] = 0;
        }
        assertApplicationGeneration(message, coordinator, id);
        assertApplicationRevision(message, coordinator, id);
        const lease = leases[id];
        if (lease && !activeLease(lease)) {
          delete leases[id];
          expiredLeaseRemoved = true;
        } else if (activeLease(lease)) {
          const holder = String(message.holder || message.workerId || '');
          if (holder !== lease.holder) {
            throw coordinatorError(
              'Another assistant window owns this application write lease.',
              'LEASE_HELD',
              coordinator,
              { applicationId: id },
            );
          }
        }
      });

      const nextSessionApps = replaceApplications(currentSession.apps, incomingSession.apps, changedApplicationIds);
      const nextQueueApps = replaceApplications(currentQueue.applications, incomingQueue.applications, changedApplicationIds);
      const nextAudit = mergeAudit(currentQueue.audit, incomingQueue.audit);
      const mergedSession = {
        participant: currentSession.participant ?? null,
        apps: nextSessionApps,
        currentAppId: Object.hasOwn(incomingSession, 'currentAppId') ? incomingSession.currentAppId : currentSession.currentAppId || null,
      };
      const mergedQueue = workQueueEngine.buildQueue(
        nextQueueApps,
        nextAudit,
      );

      const sessionMetadataChanged = mergedSession.currentAppId !== (currentSession.currentAppId || null);
      const auditChanged = !sameValue(currentQueue.audit || [], nextAudit);
      const stateChanged = changedApplicationIds.size > 0 || sessionMetadataChanged || auditChanged;
      changedApplicationIds.forEach((id) => {
        coordinator.applicationRevisions[id] = normalizedGeneration(coordinator.applicationRevisions[id]) + 1;
      });
      if (stateChanged) {
        coordinator.stateRevision += 1;
        coordinator.updatedAt = new Date().toISOString();
      }

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
      return {
        ok: true,
        persisted: stateChanged,
        changedApplicationIds: [...changedApplicationIds],
        participantIgnored: Object.hasOwn(incomingSession, 'participant')
          && !sameValue(incomingSession.participant, currentSession.participant),
        ...coordinatorFields(coordinator),
      };
    })
      .then(sendResponse)
      .catch((error) => sendResponse(coordinationError(error)));
    return true;
  }

  if (message?.type === 'CLEAR_ASSISTANT_STATE') {
    coordinate(async () => {
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
    })
      .then(sendResponse)
      .catch((error) => sendResponse(coordinationError(error)));
    return true;
  }

  if (message?.type === 'REVOKE_APPLICATION_RUN') {
    coordinate(async () => {
      const applicationId = validCoordinatorId(message.applicationId);
      const coordinator = await coordinatorState();
      assertCoordinatorEpoch(message, coordinator);
      assertParticipantSession(message, coordinator);
      assertApplicationGeneration(message, coordinator, applicationId);
      assertApplicationRevision(message, coordinator, applicationId);
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
    })
      .then(sendResponse)
      .catch((error) => sendResponse(coordinationError(error)));
    return true;
  }

  if (message?.type === 'CHECK_APPLICATION_RUN') {
    coordinate(async () => {
      const applicationId = validCoordinatorId(message.applicationId);
      const coordinator = await coordinatorState();
      assertCoordinatorEpoch(message, coordinator);
      assertParticipantSession(message, coordinator);
      const applicationGeneration = assertApplicationGeneration(message, coordinator, applicationId);
      const applicationRevision = assertApplicationRevision(message, coordinator, applicationId);
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
    })
      .then(sendResponse)
      .catch((error) => sendResponse(coordinationError(error, { allowed: false })));
    return true;
  }

  if (message?.type === 'EXECUTE_APPLICATION_COMMAND') {
    coordinate(async () => {
      const applicationId = validCoordinatorId(message.applicationId);
      const tabId = Number(message.tabId);
      const documentId = String(message.documentId || '');
      const command = message.command && typeof message.command === 'object' ? structuredClone(message.command) : null;
      if (!Number.isInteger(tabId) || tabId < 0) throw new Error('A valid application tab is required.');
      if (!documentId) throw new Error('A bound application document is required.');
      if (!APPLICATION_COMMAND_TYPES.has(command?.type)) throw new Error('Unsupported application command.');
      if (!command.routePolicy || typeof command.routePolicy !== 'object') throw new Error('The application command is missing its bound route policy.');

      const [coordinator, leaseResult, sessionResult] = await Promise.all([
        coordinatorState(),
        chrome.storage.local.get(LEASE_STORAGE_KEY),
        chrome.storage.session.get(SESSION_STORAGE_KEY),
      ]);
      assertCoordinatorEpoch(message, coordinator);
      assertParticipantSession(message, coordinator);
      const applicationGeneration = assertApplicationGeneration(message, coordinator, applicationId);
      const applicationRevision = assertApplicationRevision(message, coordinator, applicationId);
      const savedApplication = (sessionResult[SESSION_STORAGE_KEY]?.apps || [])
        .find((application) => application.id === applicationId);
      if (!savedApplication || !Number.isInteger(savedApplication.tabId) || savedApplication.tabId !== tabId) {
        throw coordinatorError(
          'The command target no longer matches the saved application tab.',
          'APPLICATION_TAB_MISMATCH',
          coordinator,
          { applicationId },
        );
      }

      const requireLease = WRITE_COMMAND_TYPES.has(command.type) || Boolean(message.requireLease);
      if (requireLease) {
        const holder = validCoordinatorId(message.holder);
        const leases = { ...(leaseResult[LEASE_STORAGE_KEY] || {}) };
        const lease = leases[applicationId];
        if (!activeLease(lease) || lease.holder !== holder) {
          throw coordinatorError(
            'This application run no longer owns the write lease.',
            'LEASE_LOST',
            coordinator,
            { applicationId },
          );
        }
        leases[applicationId] = {
          ...lease,
          expiresAt: new Date(Date.now() + COMMAND_LEASE_MS).toISOString(),
        };
        await chrome.storage.local.set({ [LEASE_STORAGE_KEY]: leases });
      }

      const target = { tabId, documentId };
      const unregister = registerCommandTarget(applicationId, target);
      let dispatch;
      try {
        dispatch = Promise.resolve(chrome.tabs.sendMessage(tabId, command, { documentId }));
      } catch (error) {
        unregister();
        throw error;
      }
      return {
        applicationId,
        applicationGeneration,
        applicationRevision,
        requireLease,
        holder: message.holder,
        dispatch: dispatch.finally(unregister),
        coordinator: coordinatorFields(coordinator),
      };
    })
      .then(async (started) => {
        let result;
        try {
          result = await started.dispatch;
        } catch (error) {
          await coordinate(() => shortenCommandLease(started.applicationId, started.holder));
          return {
            ok: false,
            dispatched: true,
            stale: false,
            code: 'TAB_COMMAND_FAILED',
            error: error?.message || 'The application tab rejected the command.',
            ...started.coordinator,
          };
        }

        try {
          const authorization = await coordinate(async () => {
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
              const lease = leaseResult[LEASE_STORAGE_KEY]?.[started.applicationId];
              if (!activeLease(lease) || lease.holder !== started.holder) {
                throw coordinatorError(
                  'This application run no longer owns the write lease.',
                  'LEASE_LOST',
                  coordinator,
                  { applicationId: started.applicationId },
                );
              }
              await shortenCommandLease(started.applicationId, started.holder);
            }
            return coordinatorFields(coordinator);
          });
          return { ...result, dispatched: true, ...authorization };
        } catch (error) {
          return coordinationError(error, { dispatched: true });
        }
      })
      .then(sendResponse)
      .catch((error) => sendResponse(coordinationError(error, { dispatched: false })));
    return true;
  }

  if (message?.type === 'ACQUIRE_APPLICATION_LEASE') {
    coordinate(async () => {
      const applicationId = validCoordinatorId(message.applicationId);
      const holder = validCoordinatorId(message.holder);
      const [coordinator, result] = await Promise.all([
        coordinatorState(),
        chrome.storage.local.get(LEASE_STORAGE_KEY),
      ]);
      assertCoordinatorEpoch(message, coordinator);
      assertParticipantSession(message, coordinator);
      const applicationGeneration = assertApplicationGeneration(message, coordinator, applicationId);
      const applicationRevision = assertApplicationRevision(message, coordinator, applicationId);
      const leases = { ...(result[LEASE_STORAGE_KEY] || {}) };
      const decision = workQueueEngine.acquireLease({ lease: leases[applicationId] || null }, holder, { leaseMs: message.leaseMs });
      if (!decision.allowed) return { ok: false, ...decision, ...coordinatorFields(coordinator) };
      leases[applicationId] = decision.lease;
      await chrome.storage.local.set({ [LEASE_STORAGE_KEY]: leases });
      return { ok: true, allowed: true, lease: decision.lease, applicationGeneration, applicationRevision, ...coordinatorFields(coordinator) };
    })
      .then(sendResponse)
      .catch((error) => sendResponse(coordinationError(error, { allowed: false })));
    return true;
  }

  if (message?.type === 'RELEASE_APPLICATION_LEASE') {
    coordinate(async () => {
      const applicationId = validCoordinatorId(message.applicationId);
      const holder = validCoordinatorId(message.holder);
      const [coordinator, result] = await Promise.all([
        coordinatorState(),
        chrome.storage.local.get(LEASE_STORAGE_KEY),
      ]);
      assertCoordinatorEpoch(message, coordinator);
      assertParticipantSession(message, coordinator);
      const applicationGeneration = assertApplicationGeneration(message, coordinator, applicationId);
      const applicationRevision = assertApplicationRevision(message, coordinator, applicationId);
      const leases = { ...(result[LEASE_STORAGE_KEY] || {}) };
      if (activeLease(leases[applicationId]) && leases[applicationId].holder !== holder) {
        throw coordinatorError(
          'Another assistant window owns this application write lease.',
          'LEASE_HELD',
          coordinator,
          { applicationId },
        );
      }
      delete leases[applicationId];
      await chrome.storage.local.set({ [LEASE_STORAGE_KEY]: leases });
      return { ok: true, lease: leases[applicationId] || null, applicationGeneration, applicationRevision, ...coordinatorFields(coordinator) };
    })
      .then(sendResponse)
      .catch((error) => sendResponse(coordinationError(error)));
    return true;
  }

  if (message?.type === 'GET_CONNECTOR_STATUS') {
    storedConnector()
      .then((saved) => sendResponse({
        ok: true,
        connector: saved
          ? { ...saved.config, status: 'ready', connectedAt: saved.connectedAt, schemaFieldCount: saved.schema.length }
          : demoConnectorStatus(),
      }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === 'DISCOVER_CONNECTOR') {
    discoverConnector(message.config)
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === 'SAVE_CONNECTOR') {
    coordinate(async () => {
      const coordinator = await coordinatorState();
      assertCoordinatorEpoch(message, coordinator);
      const schema = connectorEngine.normalizeSchemaFields(message.schema);
      const config = connectorEngine.validateMappings(message.config, schema);
      const saved = { config, schema, connectedAt: new Date().toISOString() };
      const invalidation = await invalidateConnectorParticipant();
      await chrome.storage.local.set({ [CONNECTOR_STORAGE_KEY]: saved });
      return {
        ok: true,
        connector: { ...config, status: 'ready', connectedAt: saved.connectedAt, schemaFieldCount: schema.length },
        assistantInvalidated: invalidation.invalidated,
        ...coordinatorFields(invalidation.coordinator),
      };
    })
      .then(sendResponse)
      .catch((error) => sendResponse(coordinationError(error)));
    return true;
  }

  if (message?.type === 'RESET_CONNECTOR') {
    coordinate(async () => {
      const coordinator = await coordinatorState();
      assertCoordinatorEpoch(message, coordinator);
      const invalidation = await invalidateConnectorParticipant();
      await chrome.storage.local.remove(CONNECTOR_STORAGE_KEY);
      return {
        ok: true,
        connector: demoConnectorStatus(),
        assistantInvalidated: invalidation.invalidated,
        ...coordinatorFields(invalidation.coordinator),
      };
    })
      .then(sendResponse)
      .catch((error) => sendResponse(coordinationError(error)));
    return true;
  }

  if (message?.type === 'LOOKUP_RECORD') {
    const recordId = String(message.recordId || '').trim();
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,119}$/.test(recordId)) {
      sendResponse({ ok: false, record: null, message: 'Enter a valid client record ID.' });
      return false;
    }
    storedConnector()
      .then((saved) => {
        if (saved) return lookupManagedRecord(recordId, saved);
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
      })
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, record: null, error: error.message }));
    return true;
  }

  if (message?.type === 'OPEN_PROGRAMS') {
    const keys = Array.isArray(message.programs) ? message.programs : [];
    Promise.all(
      programCatalog.planWorkflows(keys)
        .map(async (workflow) => {
          const tab = await chrome.tabs.create({ url: workflow.url, active: false });
          return { ...workflow, tabId: tab.id };
        }),
    )
      .then((opened) => sendResponse({ ok: true, opened }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === 'GET_PROGRAMS') {
    sendResponse({ ok: true, programs: programCatalog.PROGRAMS });
    return false;
  }

  return false;
});
