// Coordinator writes: everything this window asks the service-worker coordinator to change — client-session claims, checkpoint persistence, run revokes, application write leases and the audit export — serialized through one persist chain.
(function installCoordinatorWrites(root) {
  'use strict';

  /**
   * deps:
   * - state, previewMode: panel state and whether the panel runs without extension APIs (preview writes nothing to the coordinator).
   * - workQueueEngine: durable queue snapshots, local preview leases, and the audit export.
   * - sendRuntime(message), recordAudit(type, application, details): the service-worker transport and the panel audit log.
   * - cancelApplicationRun, assertApplicationRun, assertUiGeneration, coordinatorStaleError, leaseConflictError: run control.
   * - withCoordinatorMutation, applyCoordinatorMetadata, applicationGenerations, applicationRevisions, restore: coordinator sync.
   * - scheduleCoordinatorSync, waitForCoordinatorSync, coordinatorSyncRunning(): sync scheduling, read when a write needs it.
   */
  function create(deps) {
    const {
      state,
      previewMode,
      workQueueEngine,
      sendRuntime,
      recordAudit,
      cancelApplicationRun,
      assertApplicationRun,
      assertUiGeneration,
      coordinatorStaleError,
      leaseConflictError,
      withCoordinatorMutation,
      applyCoordinatorMetadata,
      applicationGenerations,
      applicationRevisions,
      restore,
      scheduleCoordinatorSync,
      waitForCoordinatorSync,
      coordinatorSyncRunning,
    } = deps;
    let persistChain = Promise.resolve();

    async function revokeApplicationRun(application) {
      cancelApplicationRun(application);
      if (previewMode) {
        application.controlGeneration = Number(application.controlGeneration || 0) + 1;
        return;
      }
      await persistChain.catch(() => {});
      await withCoordinatorMutation(async () => {
        const response = await sendRuntime({
          type: 'REVOKE_APPLICATION_RUN',
          sessionEpoch: state.sessionEpoch,
          participantSessionId: state.participantSessionId,
          applicationId: application.id,
          applicationGeneration: Number(application.controlGeneration || 0),
          applicationRevision: Number(application.controlRevision || 0),
        });
        if (!response?.ok) {
          scheduleCoordinatorSync(application.id);
          throw coordinatorStaleError(response?.error);
        }
        applyCoordinatorMetadata(response);
        application.controlGeneration = Number(response.applicationGeneration ?? application.controlGeneration ?? 0);
        application.controlRevision = Number(response.applicationRevision ?? application.controlRevision ?? 0);
      });
    }

    /**
     * Asks the coordinator (CHECK_APPLICATION_RUN) whether this window may still run the application. Nothing in the panel
     * calls it today; it stays as that message's only sender, and removing it is a product decision.
     */
    async function assertCoordinatorAuthorization(application, { requireLease = false } = {}) {
      if (previewMode || !application?.id) return;
      const response = await sendRuntime({
        type: 'CHECK_APPLICATION_RUN',
        sessionEpoch: state.sessionEpoch,
        participantSessionId: state.participantSessionId,
        applicationId: application.id,
        applicationGeneration: Number(application.controlGeneration || 0),
        applicationRevision: Number(application.controlRevision || 0),
        holder: state.workerId,
        requireLease,
      });
      if (!response?.ok || !response.allowed) {
        cancelApplicationRun(application);
        scheduleCoordinatorSync(application.id);
        throw coordinatorStaleError(response?.error);
      }
    }

    function markSourceReloaded() {
      state.apps.forEach((application) => {
        if (application.status !== 'source_expired') return;
        application.durableOnly = false;
        application.error = '';
        application.status = 'paused';
        application.checkpoint = {
          kind: 'voluntary_pause',
          label: 'Verify the saved page before resuming',
          createdAt: new Date().toISOString(),
        };
        application.updatedAt = new Date().toISOString();
        recordAudit('source_reloaded', application, { toStatus: 'paused' });
      });
    }

    function durableQueue(applicationIds = null) {
      const selectedIds = applicationIds === null ? null : new Set(applicationIds);
      const applications = selectedIds === null
        ? state.apps
        : state.apps.filter((application) => selectedIds.has(application.id));
      return workQueueEngine.buildQueue(applications, state.audit);
    }

    async function commitParticipant(participant) {
      if (previewMode) {
        state.participant = participant;
        markSourceReloaded();
        return;
      }
      await withCoordinatorMutation(async () => {
        const updating = Boolean(state.participant && state.participantSessionId);
        const response = await sendRuntime({
          type: updating ? 'UPDATE_SESSION_PARTICIPANT' : 'CLAIM_CLIENT_SESSION',
          sessionEpoch: state.sessionEpoch,
          participantSessionId: state.participantSessionId,
          stateRevision: state.coordinatorRevision,
          participant,
        });
        if (!response?.ok) {
          if (response?.stale || response?.code === 'PARTICIPANT_ALREADY_CLAIMED') scheduleCoordinatorSync();
          throw coordinatorStaleError(response?.error || 'Another assistant window changed the client session.');
        }
        applyCoordinatorMetadata(response);
        if (response.claimed) {
          state.apps.forEach((application) => {
            application.controlGeneration = 0;
            application.controlRevision = 0;
          });
        }
        if (response.revokedApplicationIds?.length) await restore({ preserveView: true });
        else state.participant = participant;
        markSourceReloaded();
      });
    }

    async function persist({ applicationIds = null, includeCurrentAppId = applicationIds === null } = {}) {
      if (previewMode) return;
      const write = persistChain.catch(() => {}).then(async () => {
        for (let attempt = 0; attempt < 2; attempt += 1) {
          let retryAfterGlobalSync = false;
          await withCoordinatorMutation(async () => {
            const selectedIds = applicationIds === null ? null : new Set(applicationIds);
            const applications = selectedIds === null
              ? state.apps
              : state.apps.filter((application) => selectedIds.has(application.id));
            const sessionSnapshot = structuredClone({
              apps: applications,
              ...(includeCurrentAppId ? { currentAppId: state.currentAppId } : {}),
            });
            const queueSnapshot = durableQueue(applicationIds);
            const response = await sendRuntime({
              type: 'PERSIST_ASSISTANT_STATE',
              sessionEpoch: state.sessionEpoch,
              participantSessionId: state.participantSessionId,
              stateRevision: state.coordinatorRevision,
              applicationGenerations: applicationGenerations(),
              applicationRevisions: applicationRevisions(),
              workerId: state.workerId,
              holder: state.workerId,
              session: sessionSnapshot,
              queue: queueSnapshot,
            });
            if (!response?.ok) {
              if (response?.code === 'STALE_STATE_REVISION' && attempt === 0) {
                retryAfterGlobalSync = true;
                scheduleCoordinatorSync();
                return;
              }
              if (response?.stale) {
                applyCoordinatorMetadata(response);
                scheduleCoordinatorSync(response.applicationId || null);
                throw coordinatorStaleError(response?.error);
              }
              throw new Error(response?.error || 'The assistant could not save its current checkpoint.');
            }
            applyCoordinatorMetadata(response);
            if (response.rejectedApplicationIds?.length) {
              response.rejectedApplicationIds.forEach((id) => {
                const application = state.apps.find((item) => item.id === id);
                if (application) cancelApplicationRun(application);
              });
              scheduleCoordinatorSync(response.rejectedApplicationIds);
              throw coordinatorStaleError('An application was paused or changed in another assistant window.');
            }
          });
          if (!retryAfterGlobalSync) return;
          if (!coordinatorSyncRunning()) scheduleCoordinatorSync();
          await waitForCoordinatorSync();
          if (attempt === 1) throw coordinatorStaleError('Assistant state kept changing while this checkpoint was being saved.');
        }
        throw coordinatorStaleError('Assistant state could not be reconciled before saving.');
      });
      persistChain = write;
      await write;
    }

    async function clearAssistantState() {
      if (previewMode) return;
      const clear = persistChain.catch(() => {}).then(async () => {
        await withCoordinatorMutation(async () => {
          const response = await sendRuntime({
            type: 'CLEAR_ASSISTANT_STATE',
            sessionEpoch: state.sessionEpoch,
          });
          if (!response?.ok) {
            if (response?.stale) scheduleCoordinatorSync();
            throw new Error(response?.error || 'The previous browser session could not be cleared.');
          }
          applyCoordinatorMetadata(response);
          state.participantSessionId = '';
        });
      });
      persistChain = clear;
      await clear;
    }

    const APPLICATION_LEASE_MS = 2 * 60 * 1000;

    async function acquireApplicationLease(application) {
      const decision = previewMode
        ? workQueueEngine.acquireLease(application, state.workerId, { leaseMs: APPLICATION_LEASE_MS })
        : await sendRuntime({
          type: 'ACQUIRE_APPLICATION_LEASE',
          sessionEpoch: state.sessionEpoch,
          participantSessionId: state.participantSessionId,
          applicationId: application.id,
          applicationGeneration: Number(application.controlGeneration || 0),
          applicationRevision: Number(application.controlRevision || 0),
          holder: state.workerId,
          leaseMs: APPLICATION_LEASE_MS,
        });
      if (!decision?.allowed) {
        if (decision?.stale) {
          scheduleCoordinatorSync(application.id);
          throw coordinatorStaleError(decision?.error);
        }
        throw leaseConflictError(decision?.reason || decision?.error, decision?.lease || null);
      }
      if (!previewMode) {
        applyCoordinatorMetadata(decision);
        application.controlGeneration = Number(decision.applicationGeneration ?? application.controlGeneration ?? 0);
        application.controlRevision = Number(decision.applicationRevision ?? application.controlRevision ?? 0);
      }
      application.lease = decision.lease;
    }

    async function releaseApplicationLease(application) {
      const current = state.apps.find((item) => item.id === application.id) || application;
      if (previewMode) {
        const released = workQueueEngine.releaseLease(current, state.workerId);
        current.lease = released.lease;
      } else {
        const released = await sendRuntime({
          type: 'RELEASE_APPLICATION_LEASE',
          sessionEpoch: state.sessionEpoch,
          participantSessionId: state.participantSessionId,
          applicationId: current.id,
          applicationGeneration: Number(current.controlGeneration || 0),
          applicationRevision: Number(current.controlRevision || 0),
          holder: state.workerId,
        });
        if (!released?.ok) {
          current.lease = null;
          if (released?.stale) {
            scheduleCoordinatorSync(current.id);
            return;
          }
          throw new Error(released?.error || 'The application write lease could not be released.');
        }
        applyCoordinatorMetadata(released);
        current.controlGeneration = Number(released.applicationGeneration ?? current.controlGeneration ?? 0);
        current.controlRevision = Number(released.applicationRevision ?? current.controlRevision ?? 0);
        current.lease = released.lease;
      }
    }

    async function withApplicationLease(application, action) {
      await acquireApplicationLease(application);
      try {
        await persist({ applicationIds: [application.id] });
        return await action();
      } finally {
        await releaseApplicationLease(application);
      }
    }

    async function renewApplicationLease(application, runToken) {
      assertApplicationRun(application, runToken);
      await acquireApplicationLease(application);
      assertApplicationRun(application, runToken);
    }

    async function exportAuditLog(uiToken) {
      recordAudit('audit_exported', null);
      await persist({ applicationIds: [] });
      assertUiGeneration(uiToken);
      const payload = workQueueEngine.exportAudit(durableQueue());
      const blob = new Blob([`${JSON.stringify(payload, null, 2)}\n`], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `nava-form-filling-activity-${new Date().toISOString().slice(0, 10)}.json`;
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }

    return {
      revokeApplicationRun,
      assertCoordinatorAuthorization,
      commitParticipant,
      persist,
      clearAssistantState,
      APPLICATION_LEASE_MS,
      acquireApplicationLease,
      releaseApplicationLease,
      withApplicationLease,
      renewApplicationLease,
      exportAuditLog,
    };
  }

  const api = { create };

  root.NavaCoordinatorWrites = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
