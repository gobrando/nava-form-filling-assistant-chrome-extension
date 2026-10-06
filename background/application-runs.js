// Service-worker application runs: run revocation and checks, write leases, document-bound tab commands, and the pause that follows when an application's tab closes.
(function installApplicationRuns(root) {
  'use strict';

  /**
   * deps:
   * - rules: the coordinator rules (background/coordinator-rules.js).
   * - workQueueEngine: the shared work-queue engine.
   * - storageKeys: SESSION_STORAGE_KEY, QUEUE_STORAGE_KEY, LEASE_STORAGE_KEY, COORDINATOR_STORAGE_KEY.
   * - APPLICATION_COMMAND_TYPES, WRITE_COMMAND_TYPES: the tab commands a run may send, and those that need the write lease.
   * - COMMAND_LEASE_MS: how long a write command extends its holder's lease.
   * - coordinate(operation): appends one operation to the coordinator chain.
   * - coordinatorState, revokeApplications, registerCommandTarget, shortenCommandLease: the coordinator core.
   * - respondCoordinated(operation, sendResponse, errorExtras): runs one operation on the coordinator chain.
   */
  function create(deps) {
    const {
      rules,
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
    } = deps;
    const { SESSION_STORAGE_KEY, QUEUE_STORAGE_KEY, LEASE_STORAGE_KEY, COORDINATOR_STORAGE_KEY } = storageKeys;
    const {
      validCoordinatorId,
      coordinatorFields,
      coordinatorError,
      invalidateApplicationRun,
      assertCoordinatorEpoch,
      assertApplicationGeneration,
      assertApplicationRevision,
      assertCurrentApplicationRun,
      assertActiveLeaseHolder,
      assertLeaseNotHeldByOther,
      coordinationError,
    } = rules;

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
    return { closeApplicationTab, routeApplicationRunMessage };
  }

  const api = { create };

  root.NavaApplicationRuns = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
