// Pure page-scan analysis: the participant a scan sends, the merge of the agent plan into the engine analysis, the scanned-application record, and its scan_completed audit details.
(function installScanAnalysis(root) {
  'use strict';

  const CHOICE_FIELD_TYPES = ['radio', 'checkbox', 'select-one'];

  /** Usage counters the audit copies only when the model runtime reported a finite number: [audit detail, usage field]. */
  const OPTIONAL_USAGE_DETAILS = [
    ['modelContextUsageUnits', 'contextUsageUnits'],
    ['modelInputTokens', 'inputTokens'],
    ['modelOutputTokens', 'outputTokens'],
  ];

  /** The participant record sent with a scan; BenefitsCal applications add the caseworker's program selection. */
  function participantForApplication(participant, application) {
    if (application?.workflowId !== 'benefitscal') return participant;
    if (!Array.isArray(application.programIds) || application.programSelectionRequired) return participant;
    const selected = new Set(application.programIds);
    return {
      ...participant,
      applicationSelection: {
        calfresh: selected.has('calfresh'),
        medical: selected.has('medical'),
        calworks: selected.has('calworks'),
      },
    };
  }

  /** Answer options for an agent-reported gap: one per grouped control, otherwise the field's own options. */
  function agentGapOptions(members, field) {
    if (members.length > 1) {
      return members.map((member) => ({
        value: member.optionValue ?? member.value ?? member.optionLabel ?? member.label,
        label: member.optionLabel ?? member.label ?? member.optionValue ?? member.value,
      }));
    }
    return (field.options || []).map((option) => ({
      value: option.value ?? option.optionValue ?? option.label,
      label: option.label ?? option.optionLabel ?? option.value,
    }));
  }

  /** The question to ask: the agent's wording, else the label when it is already a question, else a generic prompt. */
  function agentGapQuestion(gap, label) {
    if (gap.question) return gap.question;
    return String(label).endsWith('?') ? label : `What should I enter for ${String(label).toLowerCase()}?`;
  }

  /** A caseworker question for a gap the agent found that the engine analysis did not. */
  function gapFromAgent(rawFields, gap) {
    const members = (rawFields || []).filter((field) =>
      field.fieldKey === gap.fieldKey || field.groupKey === gap.fieldKey);
    const field = members[0] || {};
    const groupOptions = agentGapOptions(members, field);
    const choice = groupOptions.length > 0 || CHOICE_FIELD_TYPES.includes(field.type);
    const label = field.question || field.label || 'Required form question';
    return {
      fieldKey: gap.fieldKey,
      label,
      purpose: '',
      question: agentGapQuestion(gap, label),
      kind: choice ? 'decision' : 'required',
      required: Boolean(field.required),
      inputType: choice ? 'choice' : 'text',
      options: groupOptions,
      sensitive: Boolean(field.sensitive),
      agentReason: gap.reason || '',
    };
  }

  /** Engine gaps reworded by matching agent suggestions, followed by the agent's remaining gaps. */
  function mergeAgentGaps(analysisGaps, planGaps, rawFields) {
    const suggestedGaps = new Map((planGaps || []).map((gap) => [gap.fieldKey, gap]));
    const gaps = analysisGaps.map((gap) => {
      const coveredKeys = [gap.fieldKey, ...(gap.members || []).map((member) => member.fieldKey)];
      const suggestion = coveredKeys.map((fieldKey) => suggestedGaps.get(fieldKey)).find(Boolean);
      if (!suggestion) return gap;
      coveredKeys.forEach((fieldKey) => suggestedGaps.delete(fieldKey));
      return {
        ...gap,
        question: gap.inputType === 'multi_choice' ? gap.question : (suggestion.question || gap.question),
        agentReason: suggestion.reason || '',
      };
    });
    suggestedGaps.forEach((gap) => gaps.push(gapFromAgent(rawFields, gap)));
    return gaps;
  }

  /** The engine analysis for a scanned page with the agent plan's purposes and gaps merged in. */
  function analysisFromAgentPlan(engine, response, participant, plan) {
    const analysis = engine.buildAnalysis(response.fields || [], participant, {
      purposeOverrides: plan.purposeOverrides,
      requirePurposeOverrides: true,
    });
    const gaps = mergeAgentGaps(analysis.gaps, plan.gaps, response.fields || []);
    return {
      ...analysis,
      gaps,
      counts: { ...analysis.counts, missing: gaps.length },
    };
  }

  /** Queue status after a scan: no form, questions for the caseworker, or ready to fill. */
  function scannedStatus(analysis, canContinue) {
    if ((analysis.counts?.fields || 0) === 0 && !canContinue) return 'no_form';
    return analysis.gaps.length ? 'needs_attention' : 'ready_to_fill';
  }

  /** The scan_completed audit details, including whatever model usage the planner reported. */
  function scanAuditDetails({ analysis, agentic, usage, checkpointKind, status }) {
    const optionalUsage = Object.fromEntries(OPTIONAL_USAGE_DETAILS
      .filter(([, field]) => Number.isFinite(usage?.[field]))
      .map(([detail, field]) => [detail, usage[field]]));
    return {
      fieldCount: analysis.counts?.fields || 0,
      gapCount: analysis.gaps?.length || 0,
      modelRuntime: agentic?.runtime,
      modelPromptCount: usage?.prompts || 0,
      modelDurationMs: usage?.durationMs || 0,
      modelInputCharacters: usage?.inputCharacters || 0,
      modelOutputCharacters: usage?.outputCharacters || 0,
      ...optionalUsage,
      modelApiCostMicros: Math.round(Number(usage?.apiCostUsd || 0) * 1_000_000),
      ...(Number.isFinite(usage?.providerReportedCostUsd)
        ? { modelProviderReportedCostMicros: Math.round(Number(usage.providerReportedCostUsd) * 1_000_000) }
        : {}),
      checkpointKind,
      toStatus: status,
    };
  }

  /**
   * Binds the record builder to the URL, hashing and provenance helpers it needs.
   * deps: signatureHash (work queue), hostLabel and provenanceForScan (panel format), urlOrigin, urlPath, commandLocation (policy).
   */
  function create({ signatureHash, hostLabel, provenanceForScan, urlOrigin, urlPath, commandLocation }) {
    /** Card title and queue label: the caseworker's requested name first, then the playbook, page or host. */
    function displayNames(previous, response, tabUrl, observedUrl) {
      return {
        name: previous.requestedName || previous.name || response.playbook?.name || response.page?.title || hostLabel(tabUrl),
        queueLabel: previous.requestedName || previous.queueLabel || response.playbook?.name || hostLabel(observedUrl),
      };
    }

    /** The approved origins and path prefixes: kept once set, otherwise pinned to the page that was scanned. */
    function approvedScope(previous, observedUrl) {
      return {
        allowedOrigins: previous.allowedOrigins?.length ? previous.allowedOrigins : [urlOrigin(observedUrl)].filter(Boolean),
        allowedPathPrefixes: previous.allowedPathPrefixes?.length ? previous.allowedPathPrefixes : [urlPath(observedUrl)].filter(Boolean),
      };
    }

    /** Where a paused run may resume: the page location and signature, stored as hashes for verification. */
    function resumePointFor(response, tabUrl) {
      return {
        location: response.page?.url || tabUrl,
        commandLocationHash: signatureHash(commandLocation(response.page?.url || tabUrl)),
        pageSignature: response.navigationGate?.pageSignature || '',
        pageSignatureHash: signatureHash(response.navigationGate?.pageSignature || ''),
        capturedAt: new Date().toISOString(),
      };
    }

    /** The application record for a completed scan, before the approved-site policy is attached. */
    function scannedApplication({ previous, id, tab, response, observedUrl, analysis, agentic, checkpoint, preservePageProgress }) {
      const fieldsFound = analysis.counts?.fields || 0;
      const canContinue = response.navigationGate?.kind === 'next';
      const { name, queueLabel } = displayNames(previous, response, tab.url, observedUrl);
      const { allowedOrigins, allowedPathPrefixes } = approvedScope(previous, observedUrl);
      return {
        ...previous,
        id,
        tabId: tab.id,
        name,
        queueLabel,
        url: observedUrl,
        page: response.page,
        pageTools: response.tools || previous.pageTools || [],
        status: scannedStatus(analysis, canContinue),
        analysis,
        agentic,
        playbook: response.playbook,
        submitGate: response.submitGate,
        navigationGate: response.navigationGate,
        error: fieldsFound === 0 && !canContinue ? 'No visible application fields or safe continuation controls were found on this page.' : '',
        provenance: provenanceForScan(previous.provenance, analysis.observed, preservePageProgress),
        blocked: preservePageProgress ? (previous.blocked || []) : [],
        empty: preservePageProgress ? (previous.empty || []) : [],
        checkpoint,
        completedPages: previous.completedPages || [],
        autoRun: Boolean(previous.autoRun),
        visitedSignatures: previous.visitedSignatures || [],
        allowedOrigins,
        allowedPathPrefixes,
        resumePoint: resumePointFor(response, tab.url),
        updatedAt: new Date().toISOString(),
      };
    }

    return { displayNames, approvedScope, resumePointFor, scannedApplication };
  }

  const api = {
    participantForApplication,
    agentGapOptions,
    agentGapQuestion,
    gapFromAgent,
    mergeAgentGaps,
    analysisFromAgentPlan,
    scannedStatus,
    scanAuditDetails,
    create,
  };

  root.NavaScanAnalysis = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
