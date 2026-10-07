// Coordinator merge rules: which of this window's applications, audit events and current application survive a sync with the service-worker coordinator. Pure functions of their inputs.
(function installCoordinatorMerge(root) {
  'use strict';

  /**
   * deps:
   * - workQueueEngine: NavaWorkQueueEngine, whose buildQueue sanitizes and orders the merged audit.
   */
  function create(deps) {
    const {
      workQueueEngine,
    } = deps;

    /** True when this window's control generation or revision for an application differs from the coordinator's. */
    function controlDiffersFromCoordinator(application, coordinator) {
      return Number(coordinator.applicationGenerations?.[application.id] || 0) !== Number(application.controlGeneration || 0)
        || Number(coordinator.applicationRevisions?.[application.id] || 0) !== Number(application.controlRevision || 0);
    }

    /**
     * Merges this window's applications with the coordinator's for the same client session. An application changed
     * elsewhere (control moved, or removed by the coordinator) takes the authoritative copy; an unchanged one keeps the
     * local copy; one the coordinator has never seen stays local. Order: authoritative first, then locally unpersisted.
     */
    function mergeApplicationsWithCoordinator(localApps, authoritativeApps, coordinator) {
      const localById = new Map(localApps.map((application) => [application.id, application]));
      const authoritativeIds = new Set(authoritativeApps.map((application) => application.id));
      const locallyUnpersistedIds = new Set(localApps.filter((application) => (
        !authoritativeIds.has(application.id)
        && !Object.hasOwn(coordinator.applicationGenerations || {}, application.id)
        && !Object.hasOwn(coordinator.applicationRevisions || {}, application.id)
      )).map((application) => application.id));
      const changedIds = new Set(localApps.filter((application) => (
        (!authoritativeIds.has(application.id) && !locallyUnpersistedIds.has(application.id))
        || controlDiffersFromCoordinator(application, coordinator)
      )).map((application) => application.id));
      const apps = authoritativeApps.map((authoritative) => {
        const local = localById.get(authoritative.id);
        return local && !changedIds.has(authoritative.id)
          ? local
          : authoritative;
      }).concat([...locallyUnpersistedIds].map((id) => localById.get(id)).filter(Boolean));
      return { apps, changedIds, localById };
    }

    /** The coordinator's audit plus this window's events for the applications it kept (and session-wide events), in time order. */
    function mergeAuditWithCoordinator(localAudit, authoritativeAudit, preservedIds) {
      const mergedAudit = new Map(authoritativeAudit.map((event) => [event.id, event]));
      localAudit
        .filter((event) => !event.applicationId || preservedIds.has(event.applicationId))
        .forEach((event) => mergedAudit.set(event.id, event));
      return workQueueEngine.buildQueue([], [...mergedAudit.values()]
        .sort((left, right) => Date.parse(left.at || 0) - Date.parse(right.at || 0))).audit;
    }

    /** Keeps the current application if it survived a sync; otherwise adopts the coordinator's saved choice when that one exists. */
    function currentApplicationAfterSync(apps, currentAppId, savedCurrentAppId) {
      const exists = (id) => apps.some((application) => application.id === id);
      if (exists(currentAppId)) return currentAppId;
      return exists(savedCurrentAppId) ? savedCurrentAppId : null;
    }

    return {
      controlDiffersFromCoordinator,
      mergeApplicationsWithCoordinator,
      mergeAuditWithCoordinator,
      currentApplicationAfterSync,
    };
  }

  const api = { create };

  root.NavaCoordinatorMerge = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
