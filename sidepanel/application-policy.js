// Approved-location and checkpoint rules: which origins and paths an application may touch, how a tab binds to one document, and when an automated run must stop for a human.
(function installApplicationPolicy(root) {
  'use strict';

  const MAX_AUTOMATED_PAGES = 60;
  const DEFAULT_AUTOMATED_PAGES = 12;

  function urlOrigin(value) {
    try { return new URL(value).origin; } catch { return ''; }
  }

  function urlPath(value) {
    try { return new URL(value).pathname; } catch { return ''; }
  }

  function urlSearch(value) {
    try {
      const url = new URL(value);
      const params = new URLSearchParams(url.search);
      params.sort();
      const normalized = params.toString();
      return normalized ? `?${normalized}` : '';
    } catch {
      return '';
    }
  }

  function urlHash(value) {
    try { return new URL(value).hash; } catch { return ''; }
  }

  function commandLocation(value) {
    try {
      const url = new URL(value);
      return `${url.origin}${url.pathname}${urlSearch(url.href)}${url.hash}`;
    } catch {
      return '';
    }
  }

  function pathMatchesPrefix(path, prefix) {
    if (!path || !prefix) return false;
    if (prefix.endsWith('/')) return path.startsWith(prefix);
    return path === prefix || path.startsWith(`${prefix}/`);
  }

  function assertSameDocumentLocation(expectedUrl, observedUrl) {
    if (commandLocation(expectedUrl) !== commandLocation(observedUrl)) {
      throw new Error('The browser tab navigated before the assistant could safely read or write it. Review the current page and try again.');
    }
  }

  function checkpoint(kind, label) {
    return { kind, label, createdAt: new Date().toISOString() };
  }

  function checkpointFromScan(response, fieldsFound) {
    if (response.submitGate?.oneTimeCodePresent && !response.submitGate?.oneTimeCodeComplete) return checkpoint('otp', 'One-time code required');
    if (response.analysis?.gaps?.length) return checkpoint('human_input', 'Caseworker answers required');
    if (response.submitGate?.botCheckPresent && !response.submitGate?.botCheckComplete) return checkpoint('captcha', 'Human bot check required');
    if (response.navigationGate?.kind === 'final_review') {
      const signal = `${response.navigationGate.text || ''} ${response.navigationGate.reason || ''}`;
      if (/signature|sign\b/i.test(signal)) return checkpoint('signature', 'Signature required');
      if (/certif|attest|declaration|affirm/i.test(signal)) return checkpoint('certification', 'Certification required');
      return checkpoint('final_review', 'Final review required');
    }
    if (fieldsFound === 0 && response.navigationGate?.kind !== 'next') return checkpoint('navigation_unknown', 'No approved continuation found');
    if (response.navigationGate?.kind === 'manual') return checkpoint('navigation_unknown', 'Manual page continuation required');
    return null;
  }

  function automatedPageLimit(application) {
    if (application.workflowId === 'benefitscal') return MAX_AUTOMATED_PAGES;
    if (application.workflowId === 'riverside-ihss') return 20;
    if (application.workflowId === 'riverside-wic') return 10;
    return DEFAULT_AUTOMATED_PAGES;
  }

  /**
   * Binds the rules that need the program catalog and a host label for messages.
   * `programs` is the known-application list; `hostLabel(url)` names a host in errors.
   */
  function create({ programs, hostLabel }) {
    function attachApplicationPolicy(application) {
      const currentOrigin = urlOrigin(application.url);
      const matchingProgram = programs.find((program) => (
        program.workflowId === application.workflowId
        || program.allowedOrigins?.includes(currentOrigin)
      ));
      return {
        ...application,
        workflowId: application.workflowId || matchingProgram?.workflowId || '',
        allowedOrigins: matchingProgram?.allowedOrigins
          || (application.allowedOrigins?.length ? application.allowedOrigins : (currentOrigin ? [currentOrigin] : [])),
        allowedPathPrefixes: matchingProgram?.allowedPathPrefixes
          || (application.allowedPathPrefixes || []).filter((prefix) => prefix !== '/'),
      };
    }

    function assertApprovedApplicationLocation(application, observedUrl) {
      if (!application?.id) return;
      const observedOrigin = urlOrigin(observedUrl);
      const observedPath = urlPath(observedUrl);
      const approvedOrigins = application.allowedOrigins || [];
      const approvedPathPrefixes = application.allowedPathPrefixes || [];
      const originalOrigin = urlOrigin(application.url);
      const originApproved = approvedOrigins.length
        ? approvedOrigins.includes(observedOrigin)
        : !originalOrigin || originalOrigin === observedOrigin;
      const pathApproved = !approvedPathPrefixes.length
        || approvedPathPrefixes.some((prefix) => pathMatchesPrefix(observedPath, prefix));
      if (!originApproved || !pathApproved) {
        throw new Error(`The ${application.name || 'application'} tab left its approved site. The assistant paused without reading or writing ${hostLabel(observedUrl)}.`);
      }
    }

    return { attachApplicationPolicy, assertApprovedApplicationLocation };
  }

  const api = {
    MAX_AUTOMATED_PAGES,
    DEFAULT_AUTOMATED_PAGES,
    urlOrigin,
    urlPath,
    urlSearch,
    urlHash,
    commandLocation,
    pathMatchesPrefix,
    assertSameDocumentLocation,
    checkpoint,
    checkpointFromScan,
    automatedPageLimit,
    create,
  };

  root.NavaApplicationPolicy = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
