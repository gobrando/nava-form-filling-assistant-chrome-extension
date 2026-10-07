// Pure side-panel presentation helpers: HTML escaping, masked display values, provenance merging, labels, and model-usage totals.
(function installPanelFormat(root) {
  'use strict';

  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function encoded(value) {
    return encodeURIComponent(String(value));
  }

  function decoded(value) {
    return decodeURIComponent(String(value));
  }

  function displayValue(key, value) {
    if (['ssn', 'ein'].includes(key)) {
      const digits = String(value ?? '').replace(/\D/g, '');
      return digits.length >= 4 ? `••••${digits.slice(-4)}` : '••••';
    }
    return String(value ?? '');
  }

  function mergeVerifiedProvenance(...collections) {
    const byField = new Map();
    collections.flat().filter(Boolean).forEach((item) => {
      if (!item?.fieldKey) return;
      const normalized = { ...item };
      if (normalized.sensitive) {
        const digits = String(normalized.value ?? '').replace(/\D/g, '');
        normalized.value = digits.length >= 4 ? `••••${digits.slice(-4)}` : '••••';
      }
      delete normalized.sensitive;
      byField.set(normalized.fieldKey, normalized);
    });
    return [...byField.values()];
  }

  function provenanceForScan(previousProvenance, observed, preservePageProgress) {
    return mergeVerifiedProvenance(
      preservePageProgress ? (previousProvenance || []) : [],
      observed || [],
    );
  }

  function formatTimestamp(value) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? 'Unavailable' : date.toLocaleString();
  }

  function hostLabel(url) {
    try {
      return new URL(url).hostname.replace(/^www\./, '');
    } catch {
      return 'Current tab';
    }
  }

  function providerInitials(name) {
    return (String(name).match(/[A-Za-z0-9]+/g) || [])
      .slice(0, 2)
      .map((word) => word[0])
      .join('')
      .toUpperCase();
  }

  function sourceLabel(source) {
    return { record: 'Record', changed: 'Changed', user: 'You', page: 'On page', empty: 'Empty' }[source] || source;
  }

  function progressFor(application) {
    if (application.status === 'ready_for_review') return 100;
    if (application.status === 'needs_attention') return 55;
    if (application.status === 'ready_to_fill') return 35;
    if (['paused', 'handoff_pending'].includes(application.status)) return 20;
    return 8;
  }

  function agentUsageSummary(agentic) {
    const usage = agentic?.usage;
    if (!usage) return '';
    const prompts = Number(usage.prompts || 0);
    const seconds = Number(usage.durationMs || 0) / 1000;
    const cost = Number(usage.apiCostUsd || 0);
    const context = usage.contextUsageUnits === null || usage.contextUsageUnits === undefined
      ? ''
      : ` · ${Number(usage.contextUsageUnits).toLocaleString()} context units`;
    const tokens = usage.inputTokens === null || usage.inputTokens === undefined
      ? ''
      : ` · ${Number(usage.inputTokens).toLocaleString()} in / ${Number(usage.outputTokens || 0).toLocaleString()} out tokens`;
    const subscription = agentic?.billing === 'subscription-allowance-no-direct-api-key';
    return `${prompts} model prompt${prompts === 1 ? '' : 's'}${context}${tokens} · ${seconds.toFixed(1)}s model time · $${cost.toFixed(2)} direct API-key cost${subscription ? ' · subscription allowance used' : ''}`;
  }

  /** Sum of one usage counter across two plans; a missing counter counts as zero. */
  function usageSum(before, after, key) {
    return Number(before[key] || 0) + Number(after[key] || 0);
  }

  function usageReported(value) {
    return value !== null && value !== undefined;
  }

  /** Sum of a counter that providers may not report: null unless both plans reported it. */
  function reportedUsageSum(before, after, key) {
    return usageReported(before[key]) && usageReported(after[key]) ? usageSum(before, after, key) : null;
  }

  function mergeAgenticMetadata(previous, current) {
    if (!previous) return { ...current, planCount: 1 };
    const before = previous.usage || {};
    const after = current.usage || {};
    return {
      ...current,
      planCount: Number(previous.planCount || 1) + 1,
      usage: {
        prompts: usageSum(before, after, 'prompts'),
        inputCharacters: usageSum(before, after, 'inputCharacters'),
        outputCharacters: usageSum(before, after, 'outputCharacters'),
        contextUsageUnits: reportedUsageSum(before, after, 'contextUsageUnits'),
        durationMs: usageSum(before, after, 'durationMs'),
        inputTokens: reportedUsageSum(before, after, 'inputTokens'),
        outputTokens: reportedUsageSum(before, after, 'outputTokens'),
        apiCostUsd: usageSum(before, after, 'apiCostUsd'),
        providerReportedCostUsd: reportedUsageSum(before, after, 'providerReportedCostUsd'),
      },
    };
  }

  const api = {
    escapeHtml,
    encoded,
    decoded,
    displayValue,
    mergeVerifiedProvenance,
    provenanceForScan,
    formatTimestamp,
    hostLabel,
    providerInitials,
    sourceLabel,
    progressFor,
    agentUsageSummary,
    mergeAgenticMetadata,
  };

  root.NavaPanelFormat = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
