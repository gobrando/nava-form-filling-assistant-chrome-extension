// Service-worker client session: the browser's single claimed client session and the assistant state snapshot (session applications plus the durable queue) that side-panel windows save and restore.
(function installClientSession(root) {
  'use strict';

  /**
   * deps:
   * - rules: the coordinator rules (background/coordinator-rules.js).
   * - workQueueEngine: the shared work-queue engine.
   * - storageKeys: SESSION_STORAGE_KEY, QUEUE_STORAGE_KEY, LEASE_STORAGE_KEY, COORDINATOR_STORAGE_KEY.
   * - coordinatorState, readCoordinatedState, revokeApplications, cancelApplicationTargets: the coordinator core.
   * - respondCoordinated(operation, sendResponse, errorExtras): runs one operation on the coordinator chain.
   */
  function create(deps) {
    const {
      rules,
      workQueueEngine,
      storageKeys,
      coordinatorState,
      readCoordinatedState,
      revokeApplications,
      cancelApplicationTargets,
      respondCoordinated,
    } = deps;
    const { SESSION_STORAGE_KEY, QUEUE_STORAGE_KEY, LEASE_STORAGE_KEY, COORDINATOR_STORAGE_KEY } = storageKeys;
    const {
      mergeAudit,
      validCoordinatorId,
      normalizedGeneration,
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
      revokedApplication,
      assertCoordinatorEpoch,
      assertStateRevision,
      assertParticipantSession,
      assertApplicationGeneration,
      assertApplicationRevision,
      assertLeaseNotHeldByOther,
    } = rules;

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
    return { routeSessionMessage };
  }

  const api = { create };

  root.NavaClientSession = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
