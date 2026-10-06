// Side panel to service worker to page agent messaging: assistant-state recovery, tab document binding, versioned page-agent injection, and route-checked tab commands.
(function installExtensionMessaging(root) {
  'use strict';

  const PAGE_AGENT_VERSION = 6;

  /**
   * deps:
   * - previewMode: true when the panel runs without extension APIs (simulated preview).
   * - state: the panel state; read for the coordinator session identity and worker id.
   * - sendRuntime(message), previewTabMessage(message): service-worker and preview transports.
   * - onStaleCommand(application): cancels the stale run and schedules a coordinator sync.
   * - coordinatorStaleError(message): the error thrown after a stale command.
   * - assertApprovedApplicationLocation, assertSameDocumentLocation, urlOrigin, urlPath, urlSearch, urlHash:
   *   the application route policy.
   */
  function create(deps) {
    const {
      previewMode,
      state,
      sendRuntime,
      previewTabMessage,
      onStaleCommand,
      coordinatorStaleError,
      assertApprovedApplicationLocation,
      assertSameDocumentLocation,
      urlOrigin,
      urlPath,
      urlSearch,
      urlHash,
    } = deps;

    async function requestAssistantState(
      send = sendRuntime,
      wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    ) {
      const delays = [0, 150, 500];
      let lastError = '';
      for (const delay of delays) {
        if (delay) await wait(delay);
        try {
          const response = await send({ type: 'GET_ASSISTANT_STATE' });
          if (response?.ok) return response;
          lastError = response?.error || '';
        } catch (error) {
          lastError = error?.message || String(error || '');
        }
      }
      if (lastError && !/extension context invalidated|receiving end does not exist|message port closed|could not establish connection/i.test(lastError)) {
        throw new Error(lastError);
      }
      throw new Error('The extension was reloaded safely. Close and reopen the side panel to reconnect. Saved application checkpoints remain available, but client data must be reloaded before filling resumes.');
    }

    async function probeTabDocument(tabId) {
      const [probe] = await chrome.scripting.executeScript({
        target: { tabId, frameIds: [0] },
        func: () => ({ url: location.href, origin: location.origin, path: location.pathname }),
      });
      if (!probe?.documentId || !probe?.result?.url) {
        throw new Error('The application page changed before the assistant could bind to it. Try again after it finishes loading.');
      }
      return probe;
    }

    /** The page agent's readiness reply, or null when no agent answers in that document. */
    async function pingPageAgent(tabId, messageOptions) {
      try {
        return await chrome.tabs.sendMessage(tabId, { type: 'NAVA_PING' }, messageOptions);
      } catch {
        return null;
      }
    }

    async function ensurePageAgent(tab, documentId = null) {
      if (previewMode) return;
      if (!tab?.id || !/^https?:/i.test(tab.url || '')) {
        throw new Error('Open a regular website with a form, then try again. Chrome system pages cannot be filled.');
      }
      const messageOptions = documentId ? { documentId } : undefined;
      const pong = await pingPageAgent(tab.id, messageOptions);
      if (pong?.ok && pong.agentVersion === PAGE_AGENT_VERSION && pong.adaptersReady) return;
      try {
        await chrome.scripting.executeScript({
          target: documentId ? { tabId: tab.id, documentIds: [documentId] } : { tabId: tab.id },
          files: [
            'shared/form-engine.js',
            'shared/site-adapters.js',
            'content/page-dom.js',
            'content/field-inventory.js',
            'content/navigation-gate.js',
            'content/value-writers.js',
            'content/form-agent.js',
          ],
        });
        const verified = await chrome.tabs.sendMessage(tab.id, { type: 'NAVA_PING' }, messageOptions);
        if (verified?.ok && verified.agentVersion === PAGE_AGENT_VERSION && verified.adaptersReady) return;
      } catch {
        // The actionable error below covers stale and missing page agents.
      }
      throw new Error('This application tab still has an older form-filling agent. Refresh this tab once after reloading the extension, then scan it again. No form values were changed.');
    }

    async function sendToTab(tab, message, { application = null, requireLease = false } = {}) {
      if (previewMode) return previewTabMessage(message);
      const probe = await probeTabDocument(tab.id);
      assertSameDocumentLocation(tab.url, probe.result.url);
      if (application) assertApprovedApplicationLocation(application, probe.result.url);
      const boundTab = { ...tab, url: probe.result.url };
      await ensurePageAgent(boundTab, probe.documentId);
      const routePolicy = application ? {
        origins: application.allowedOrigins?.length ? application.allowedOrigins : [urlOrigin(application.url)],
        pathPrefixes: application.allowedPathPrefixes || [],
        expectedPath: urlPath(probe.result.url),
        expectedSearch: urlSearch(probe.result.url),
        expectedHash: urlHash(probe.result.url),
      } : {
        origins: [urlOrigin(probe.result.url)],
        exactPaths: [urlPath(probe.result.url)],
        expectedPath: urlPath(probe.result.url),
        expectedSearch: urlSearch(probe.result.url),
        expectedHash: urlHash(probe.result.url),
      };
      const command = { ...message, routePolicy };
      if (!application) {
        return chrome.tabs.sendMessage(tab.id, command, { documentId: probe.documentId });
      }
      const response = await sendRuntime({
        type: 'EXECUTE_APPLICATION_COMMAND',
        tabId: tab.id,
        documentId: probe.documentId,
        command,
        sessionEpoch: state.sessionEpoch,
        participantSessionId: state.participantSessionId,
        applicationId: application.id,
        applicationGeneration: Number(application.controlGeneration || 0),
        applicationRevision: Number(application.controlRevision || 0),
        holder: state.workerId,
        requireLease,
      });
      if (!response?.ok && response?.stale) {
        onStaleCommand(application);
        throw coordinatorStaleError(response.error);
      }
      return response;
    }

    return { requestAssistantState, probeTabDocument, ensurePageAgent, sendToTab };
  }

  const api = { PAGE_AGENT_VERSION, create };

  root.NavaExtensionMessaging = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
