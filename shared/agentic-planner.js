// Agentic planner: plans a page with the three model roles (mapper and gap analyst, then an independent reviewer) or the shared gateway, keeping only what the local policy validator accepts.
(function installAgenticPlanner(root) {
  'use strict';

  // The modules the planner composes: the globals their scripts install first, or their CommonJS exports under Node.
  const { compactText, groupedInventory, planningInventory } = root.NavaPlannerInventory
    || (typeof module !== 'undefined' ? require('./planner-inventory.js') : undefined);
  const {
    ROLE_NAMES, availability, configure, prepare, promptRole, reset, runtimeInfo, setBridgeFetchForTests, setRuntimeForTests,
  } = root.NavaPlannerRuntime || (typeof module !== 'undefined' ? require('./planner-runtime.js') : undefined);

  const MAPPING_SCHEMA = {
    type: 'object',
    properties: {
      mappings: {
        type: 'array',
        maxItems: 120,
        items: {
          type: 'object',
          properties: {
            fieldKey: { type: 'string' },
            purpose: { type: 'string' },
            confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
            reason: { type: 'string' },
          },
          required: ['fieldKey', 'purpose', 'confidence', 'reason'],
          additionalProperties: false,
        },
      },
    },
    required: ['mappings'],
    additionalProperties: false,
  };

  const GAP_SCHEMA = {
    type: 'object',
    properties: {
      gaps: {
        type: 'array',
        maxItems: 120,
        items: {
          type: 'object',
          properties: {
            fieldKey: { type: 'string' },
            question: { type: 'string' },
            reason: { type: 'string' },
          },
          required: ['fieldKey', 'question', 'reason'],
          additionalProperties: false,
        },
      },
    },
    required: ['gaps'],
    additionalProperties: false,
  };

  const REVIEW_SCHEMA = {
    type: 'object',
    properties: {
      approved: {
        type: 'array',
        maxItems: 120,
        items: {
          type: 'object',
          properties: {
            fieldKey: { type: 'string' },
            purpose: { type: 'string' },
            reason: { type: 'string' },
          },
          required: ['fieldKey', 'purpose', 'reason'],
          additionalProperties: false,
        },
      },
      rejected: {
        type: 'array',
        maxItems: 120,
        items: {
          type: 'object',
          properties: {
            fieldKey: { type: 'string' },
            purpose: { type: 'string' },
            reason: { type: 'string' },
          },
          required: ['fieldKey', 'purpose', 'reason'],
          additionalProperties: false,
        },
      },
      summary: { type: 'string' },
    },
    required: ['approved', 'rejected', 'summary'],
    additionalProperties: false,
  };

  function canonicalPurposes(engine) {
    return new Set(Object.keys(engine.LABELS || {}));
  }

  function parseResult(text, label) {
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`The ${label} agent returned an unreadable plan. No form values were changed.`);
    }
  }

  function mappingPrompt(page, fields, sources) {
    return JSON.stringify({
      task: 'Map each safely understood form field to one available source purpose. Omit uncertain mappings.',
      page: { domain: compactText(page?.domain, 160) },
      availableSources: sources,
      fields,
    });
  }

  function gapPrompt(page, fields, sources) {
    return JSON.stringify({
      task: 'Find required fields or explicit decisions that lack a safe available source. Ask plain-language questions only for those gaps.',
      page: { domain: compactText(page?.domain, 160) },
      availableSourcePurposes: sources.map((source) => source.purpose),
      fields,
    });
  }

  function reviewPrompt(page, fields, sources, mapping, gaps) {
    return JSON.stringify({
      task: 'Independently approve or reject every proposed mapping. Approved pairs must exactly reuse a proposed fieldKey and purpose.',
      page: { domain: compactText(page?.domain, 160) },
      availableSources: sources,
      fields,
      proposedMappings: mapping.mappings || [],
      proposedGaps: gaps.gaps || [],
    });
  }

  function validateReview(fields, sources, mapping, review, allowedPurposes) {
    const fieldKeys = new Set(fields.map((field) => field.fieldKey));
    const sourceKeys = new Set(sources.map((source) => source.purpose));
    const proposed = new Map((mapping.mappings || []).map((item) => [`${item.fieldKey}\u0000${item.purpose}`, item]));
    const purposeOverrides = {};
    const approved = [];
    const rejected = [...(review.rejected || [])];

    (review.approved || []).forEach((item) => {
      const fieldKey = String(item.fieldKey || '');
      const purpose = String(item.purpose || '');
      const pair = `${fieldKey}\u0000${purpose}`;
      const proposal = proposed.get(pair);
      if (!fieldKeys.has(fieldKey) || !sourceKeys.has(purpose) || !proposal || proposal.confidence === 'low' || purposeOverrides[fieldKey]) {
        rejected.push({ fieldKey, purpose, reason: 'The local policy validator rejected an unknown, unavailable, unproposed, low-confidence, or duplicate mapping.' });
        return;
      }
      purposeOverrides[fieldKey] = purpose;
      approved.push({ fieldKey, purpose, reason: compactText(item.reason, 280) });
    });
    let trustedHintMappings = 0;
    fields.forEach((field) => {
      const fieldKey = String(field.fieldKey || '');
      const purpose = String(field.purposeHint || '');
      if (!fieldKey || !purpose || purposeOverrides[fieldKey] || !allowedPurposes.has(purpose)) return;
      purposeOverrides[fieldKey] = purpose;
      trustedHintMappings += 1;
      approved.push({
        fieldKey,
        purpose,
        reason: sourceKeys.has(purpose)
          ? 'Approved by the versioned site adapter and limited to an available source purpose.'
          : 'Approved by the versioned site adapter so the missing source answer becomes an explicit gap.',
        source: 'site-adapter',
      });
    });
    return { purposeOverrides, approved, rejected, trustedHintMappings };
  }

  // A proposed gap needs a caseworker only for a known, still-empty field that no approved mapping
  // can answer from a source on file, and only when it is required, a choice, or a checkbox.
  function gapNeedsAnswer(field, purposeOverrides, availablePurposes) {
    if (!field || field.alreadyFilled) return false;
    const mappedPurpose = purposeOverrides[field.fieldKey];
    if (mappedPurpose && availablePurposes.has(mappedPurpose)) return false;
    return field.required || field.options.length > 0 || field.type === 'checkbox';
  }

  function validateGaps(gaps, fields, sources, purposeOverrides) {
    const availablePurposes = new Set(sources.map((source) => source.purpose));
    const fieldFor = (gap) => fields.find((candidate) => candidate.fieldKey === gap.fieldKey);
    return (gaps.gaps || [])
      .filter((gap) => gapNeedsAnswer(fieldFor(gap), purposeOverrides, availablePurposes))
      .map((gap) => ({
        fieldKey: String(gap.fieldKey),
        question: compactText(gap.question, 280),
        reason: compactText(gap.reason, 280),
      }));
  }

  async function gatewayConfig() {
    if (root.NAVA_PLAN_GATEWAY?.endpoint && root.NAVA_PLAN_GATEWAY?.token) return root.NAVA_PLAN_GATEWAY;
    const storage = root.chrome?.storage?.local;
    if (!storage?.get) return null;
    const stored = await storage.get(['navaApiBase', 'navaApiToken', 'navaPlanModel']);
    const base = String(stored?.navaApiBase || '').replace(/\/$/, '');
    const token = String(stored?.navaApiToken || '');
    if (!base || !token) return null;
    return { endpoint: `${base}/v1/plan`, token, model: stored.navaPlanModel || undefined };
  }

  function clampGatewayPlan(plan, fields, sources, allowedPurposes) {
    const fieldKeys = new Set(fields.map((field) => field.fieldKey));
    const sourceKeys = new Set(sources.map((source) => source.purpose));
    const purposeOverrides = {};
    const approved = [];
    const rejected = [...(plan.rejected || [])];
    Object.entries(plan.purposeOverrides || {}).forEach(([fieldKey, purpose]) => {
      const fromAdapter = (plan.approved || []).some((item) => item.fieldKey === fieldKey && item.purpose === purpose && item.source === 'site-adapter');
      if (!fieldKeys.has(fieldKey) || !allowedPurposes.has(purpose) || (!sourceKeys.has(purpose) && !fromAdapter)) {
        rejected.push({
          fieldKey,
          purpose: String(purpose || ''),
          reason: 'The extension rejected a gateway mapping that was outside the inventory, the canonical purposes, or the sources on file.',
        });
        return;
      }
      purposeOverrides[fieldKey] = purpose;
      approved.push({ fieldKey, purpose, reason: 'Accepted from the shared planner after a local check.' });
    });
    const gaps = (plan.gaps || []).filter((gap) => fieldKeys.has(gap.fieldKey) && !purposeOverrides[gap.fieldKey]);
    return { ...plan, purposeOverrides, approved, rejected, gaps };
  }

  async function planThroughGateway(args, gateway) {
    const { fields, sources } = planningInventory(args.engine, args.participant, args.rawFields);
    args.onProgress?.({ phase: 'planning', agents: ROLE_NAMES, runtime: 'nava-api' });
    const response = await fetch(gateway.endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${gateway.token}`,
      },
      body: JSON.stringify({
        model: gateway.model,
        page: { domain: compactText(args.page?.domain, 160) },
        fields,
        sources,
      }),
    });
    const body = await response.json().catch(() => null);
    if (!response.ok || !body?.ok || !body.plan) {
      throw new Error(body?.error || 'The shared planner did not return a plan. No form values were changed.');
    }
    const clamped = clampGatewayPlan(body.plan, fields, sources, canonicalPurposes(args.engine));
    return {
      ...clamped,
      metadata: {
        ...(body.plan.metadata || {}),
        runtime: body.plan.metadata?.runtime || 'nava-api',
        mode: 'shared-engine',
      },
    };
  }

  // A total stays unknown (null) once any role could not report that figure.
  function sumKnown(total, value) {
    return total === null || value === null ? null : total + Number(value || 0);
  }

  function addRoleUsage(summary, item) {
    return {
      prompts: summary.prompts + Number(item.prompts || 0),
      inputCharacters: summary.inputCharacters + Number(item.inputCharacters || 0),
      outputCharacters: summary.outputCharacters + Number(item.outputCharacters || 0),
      contextUsageUnits: sumKnown(summary.contextUsageUnits, item.contextUsageUnits),
      durationMs: summary.durationMs + Number(item.durationMs || 0),
      inputTokens: sumKnown(summary.inputTokens, item.inputTokens),
      outputTokens: sumKnown(summary.outputTokens, item.outputTokens),
      apiCostUsd: 0,
      providerReportedCostUsd: sumKnown(summary.providerReportedCostUsd, item.providerReportedCostUsd),
    };
  }

  function summarizeUsage(usageEvents) {
    return usageEvents.reduce(addRoleUsage, {
      prompts: 0, inputCharacters: 0, outputCharacters: 0, contextUsageUnits: 0, durationMs: 0,
      inputTokens: 0, outputTokens: 0, apiCostUsd: 0, providerReportedCostUsd: 0,
    });
  }

  function localPlanMetadata({ mapping, review, validated, usage }) {
    const selected = runtimeInfo();
    const companion = selected.kind === 'local-cli';
    return {
      runtime: companion ? `${selected.provider}-cli-subscription` : 'chrome-gemini-nano',
      mode: companion ? 'localhost-subscription-multi-agent' : 'on-device-multi-agent',
      provider: companion ? selected.provider : 'chrome-local',
      agents: ROLE_NAMES,
      proposedMappings: (mapping.mappings || []).length,
      approvedMappings: validated.approved.length,
      rejectedMappings: validated.rejected.length,
      trustedHintMappings: validated.trustedHintMappings,
      usage,
      billing: companion ? 'subscription-allowance-no-direct-api-key' : 'on-device-no-token-charge',
      reviewedAt: new Date().toISOString(),
      summary: compactText(review.summary, 400),
    };
  }

  // Roles 1 and 2: the mapper and gap analyst run concurrently, each on its own role queue,
  // and neither sees the other's output.
  async function proposePlan(page, fields, sources, onProgress) {
    onProgress?.({ phase: 'planning', agents: ['field_mapper', 'gap_analyst'] });
    const [mappingResult, gapResult] = await Promise.all([
      promptRole('field_mapper', mappingPrompt(page, fields, sources), MAPPING_SCHEMA),
      promptRole('gap_analyst', gapPrompt(page, fields, sources), GAP_SCHEMA),
    ]);
    return {
      mapping: parseResult(mappingResult.text, 'field-mapping'),
      gaps: parseResult(gapResult.text, 'gap-analysis'),
      usageEvents: [mappingResult.usage, gapResult.usage],
    };
  }

  // Role 3: an independent reviewer session judges the proposals after both are complete.
  async function reviewProposals(page, fields, sources, proposal, onProgress) {
    onProgress?.({ phase: 'reviewing', agents: ['form_reviewer'] });
    const prompt = reviewPrompt(page, fields, sources, proposal.mapping, proposal.gaps);
    const reviewResult = await promptRole('form_reviewer', prompt, REVIEW_SCHEMA);
    return { review: parseResult(reviewResult.text, 'form-review'), usage: reviewResult.usage };
  }

  // Orchestration: resolve the runtime, redact the inventory, run the three roles, then keep only
  // what the local policy validator accepts.
  async function plan({ engine, page, rawFields, participant, onProgress } = {}) {
    if (!engine?.canonicalizeParticipant || !engine?.buildAnalysis) throw new Error('The form engine is unavailable.');
    const gateway = await gatewayConfig();
    if (gateway) return planThroughGateway({ engine, page, rawFields, participant, onProgress }, gateway);
    await prepare({ onProgress });
    const { fields, sources } = planningInventory(engine, participant, rawFields);
    const proposal = await proposePlan(page, fields, sources, onProgress);
    const { review, usage: reviewUsage } = await reviewProposals(page, fields, sources, proposal, onProgress);
    const validated = validateReview(fields, sources, proposal.mapping, review, canonicalPurposes(engine));
    const usage = summarizeUsage([...proposal.usageEvents, reviewUsage]);
    return {
      ...validated,
      gaps: validateGaps(proposal.gaps, fields, sources, validated.purposeOverrides),
      metadata: localPlanMetadata({ mapping: proposal.mapping, review, validated, usage }),
    };
  }

  const api = {
    availability,
    configure,
    gatewayConfig,
    groupedInventory,
    plan,
    prepare,
    reset,
    runtimeInfo,
    setBridgeFetchForTests,
    setRuntimeForTests,
  };
  root.NavaAgenticPlanner = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
