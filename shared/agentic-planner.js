(function installAgenticPlanner(root) {
  'use strict';

  const ROLE_NAMES = ['field_mapper', 'gap_analyst', 'form_reviewer'];
  const MODEL_OPTIONS = {
    expectedInputs: [{ type: 'text', languages: ['en'] }],
    expectedOutputs: [{ type: 'text', languages: ['en'] }],
  };

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

  const SYSTEM_PROMPTS = {
    field_mapper: `You are the field-mapping agent in Nava's form-completion system.
Map visible form controls to the supplied canonical source purposes. Work from labels,
questions, types, option text, and exact site hints. Never invent a source purpose.
Never use value shape to reinterpret an identifier. Keep different people and entities
separate. A case number is not a Social Security Number. When uncertain, omit the
mapping. Do not propose submit, signature, certification, CAPTCHA, login, payment, or
one-time-code actions. Return only schema-constrained data.`,
    gap_analyst: `You are the gap-analysis agent in Nava's form-completion system.
Identify visible required fields and decisions that have no safe source mapping. Ask for
the value in plain language. Do not guess eligibility, protected, identity, income,
household, immigration, housing, childcare, unemployment, contact-preference, SSN, or
EIN answers. Do not ask browser or selector questions. Return only schema-constrained
data.`,
    form_reviewer: `You are the independent form-review agent in Nava's form-completion
system. Review another agent's proposed field mappings against the visible field
inventory and the allowlisted source purposes. Approve only mappings supported by the
field's label, question, type, option text, or exact site hint. Reject ambiguity,
repeated-person leakage, identifier substitution, and any mapping to a source purpose
that is unavailable. Do not approve final actions or bot challenges. Return only
schema-constrained data.`,
  };

  let sessions = null;
  let preparingPromise = null;
  let roleChains = Object.fromEntries(ROLE_NAMES.map((role) => [role, Promise.resolve()]));
  let runtimeOverride = null;

  function languageModel() {
    return runtimeOverride || root.LanguageModel || null;
  }

  function normalizedAvailability(value) {
    const status = String(value || '').toLowerCase();
    if (['available', 'readily'].includes(status)) return 'available';
    if (['downloadable', 'after-download'].includes(status)) return 'downloadable';
    if (status === 'downloading') return 'downloading';
    return 'unavailable';
  }

  async function availability() {
    const model = languageModel();
    if (!model?.availability || !model?.create) return 'unavailable';
    try {
      return normalizedAvailability(await model.availability(MODEL_OPTIONS));
    } catch {
      return 'unavailable';
    }
  }

  async function createSession(role, onProgress) {
    const model = languageModel();
    return model.create({
      ...MODEL_OPTIONS,
      initialPrompts: [{ role: 'system', content: SYSTEM_PROMPTS[role] }],
      monitor(monitor) {
        monitor.addEventListener('downloadprogress', (event) => {
          onProgress?.({ role, phase: 'download', progress: Number(event.loaded || 0) });
        });
      },
    });
  }

  async function prepare({ onProgress } = {}) {
    if (sessions) return { status: 'ready', agents: ROLE_NAMES };
    if (!preparingPromise) {
      preparingPromise = (async () => {
        const status = await availability();
        if (status === 'unavailable') {
          throw new Error('The on-device language model is unavailable. Use Chrome 138 or newer on a supported desktop and enable Chrome built-in AI before starting an agentic run.');
        }
        onProgress?.({ phase: status === 'available' ? 'starting' : 'download', progress: 0 });
        const created = await Promise.all(ROLE_NAMES.map(async (role) => [role, await createSession(role, onProgress)]));
        sessions = Object.fromEntries(created);
        onProgress?.({ phase: 'ready', progress: 1 });
        return { status: 'ready', agents: ROLE_NAMES };
      })().finally(() => {
        preparingPromise = null;
      });
    }
    return preparingPromise;
  }

  function promptRole(role, prompt, responseConstraint) {
    const run = roleChains[role]
      .catch(() => undefined)
      .then(async () => {
        const session = await sessions[role].clone();
        const startedAt = Date.now();
        const contextUsageBefore = Number.isFinite(Number(session.contextUsage))
          ? Number(session.contextUsage)
          : null;
        try {
          const text = await session.prompt(prompt, { responseConstraint });
          const contextUsageAfter = Number.isFinite(Number(session.contextUsage))
            ? Number(session.contextUsage)
            : null;
          return {
            text,
            usage: {
              role,
              prompts: 1,
              inputCharacters: prompt.length,
              outputCharacters: String(text || '').length,
              contextUsageUnits: contextUsageBefore === null || contextUsageAfter === null
                ? null
                : Math.max(0, contextUsageAfter - contextUsageBefore),
              contextWindow: Number.isFinite(Number(session.contextWindow)) ? Number(session.contextWindow) : null,
              durationMs: Date.now() - startedAt,
              apiCostUsd: 0,
            },
          };
        } finally {
          session.destroy();
        }
      });
    roleChains[role] = run.catch(() => undefined);
    return run;
  }

  function compactText(value, limit = 240) {
    return String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit);
  }

  function groupedInventory(rawFields) {
    const groups = new Map();
    const singles = [];
    const groupCounts = new Map();
    (rawFields || []).forEach((field) => {
      if (!field.groupKey) return;
      groupCounts.set(field.groupKey, (groupCounts.get(field.groupKey) || 0) + 1);
    });
    (rawFields || []).forEach((field) => {
      const singletonGroup = field.groupKey && groupCounts.get(field.groupKey) === 1;
      const safe = {
        fieldKey: compactText(singletonGroup ? field.fieldKey : (field.groupKey || field.fieldKey), 180),
        type: compactText(field.type, 40),
        label: compactText(field.label),
        question: compactText(field.question),
        required: Boolean(field.required),
        alreadyFilled: Boolean(field.value || field.checked),
        purposeHint: compactText(field.purpose, 100),
        allowRepeatedPurpose: Boolean(field.allowRepeatedPurpose),
        options: [],
      };
      if (!field.groupKey || singletonGroup) {
        safe.options = (field.options || []).slice(0, 80).map((option) => compactText(option.label || option.value, 120));
        singles.push(safe);
        return;
      }
      const existing = groups.get(field.groupKey) || safe;
      existing.required = existing.required || safe.required;
      existing.alreadyFilled = existing.alreadyFilled || safe.alreadyFilled;
      existing.question = existing.question || safe.question;
      existing.purposeHint = existing.purposeHint || safe.purposeHint;
      existing.options.push(compactText(field.optionLabel || field.optionValue || field.label, 120));
      groups.set(field.groupKey, existing);
    });
    const inventory = [...singles, ...groups.values()]
      .slice(0, 80)
      .map((field) => ({ ...field, options: [...new Set(field.options)].filter(Boolean).slice(0, 30) }));
    while (JSON.stringify(inventory).length > 24_000) {
      const optionField = [...inventory]
        .filter((field) => field.options.length > 2)
        .sort((left, right) => right.options.length - left.options.length)[0];
      if (optionField) optionField.options.pop();
      else if (inventory.length > 1) inventory.pop();
      else break;
    }
    return inventory;
  }

  function sourceInventory(engine, participant) {
    const values = engine.canonicalizeParticipant(participant || {}).values;
    return Object.entries(values)
      .filter(([, value]) => value !== undefined && value !== null && value !== '')
      .map(([purpose, value]) => ({
        purpose,
        label: engine.LABELS[purpose] || purpose,
        kind: Array.isArray(value) ? 'list' : typeof value,
        sensitive: /ssn|social security|ein/i.test(`${purpose} ${engine.LABELS[purpose] || ''}`),
      }));
  }

  function redactSourceValues(engine, participant, fields) {
    const values = engine.canonicalizeParticipant(participant || {}).values;
    const terms = Object.values(values)
      .flatMap((value) => Array.isArray(value) ? value : [value])
      .map((value) => String(value ?? '').trim())
      .filter((value) => value.length >= 4)
      .sort((left, right) => right.length - left.length);
    const redact = (text) => terms.reduce((result, term) =>
      result.replace(new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), '[source value]'), String(text || ''));
    return fields.map((field) => ({
      ...field,
      label: redact(field.label),
      question: redact(field.question),
      options: field.options.map(redact),
    }));
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
    const fields = redactSourceValues(args.engine, args.participant, groupedInventory(args.rawFields));
    const sources = sourceInventory(args.engine, args.participant);
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
    const clamped = clampGatewayPlan(
      body.plan,
      fields,
      sources,
      new Set(Object.keys(args.engine.LABELS || {})),
    );
    return {
      ...clamped,
      metadata: {
        ...(body.plan.metadata || {}),
        runtime: body.plan.metadata?.runtime || 'nava-api',
        mode: 'shared-engine',
      },
    };
  }

  async function plan({ engine, page, rawFields, participant, onProgress } = {}) {
    if (!engine?.canonicalizeParticipant || !engine?.buildAnalysis) throw new Error('The form engine is unavailable.');
    const gateway = await gatewayConfig();
    if (gateway) return planThroughGateway({ engine, page, rawFields, participant, onProgress }, gateway);
    await prepare({ onProgress });
    const fields = redactSourceValues(engine, participant, groupedInventory(rawFields));
    const sources = sourceInventory(engine, participant);
    onProgress?.({ phase: 'planning', agents: ['field_mapper', 'gap_analyst'] });
    const [mappingResult, gapResult] = await Promise.all([
      promptRole('field_mapper', mappingPrompt(page, fields, sources), MAPPING_SCHEMA),
      promptRole('gap_analyst', gapPrompt(page, fields, sources), GAP_SCHEMA),
    ]);
    const mapping = parseResult(mappingResult.text, 'field-mapping');
    const gaps = parseResult(gapResult.text, 'gap-analysis');
    onProgress?.({ phase: 'reviewing', agents: ['form_reviewer'] });
    const reviewResult = await promptRole(
      'form_reviewer',
      reviewPrompt(page, fields, sources, mapping, gaps),
      REVIEW_SCHEMA,
    );
    const review = parseResult(reviewResult.text, 'form-review');
    const validated = validateReview(fields, sources, mapping, review, new Set(Object.keys(engine.LABELS || {})));
    const availablePurposes = new Set(sources.map((source) => source.purpose));
    const validatedGaps = (gaps.gaps || []).filter((gap) => {
      const field = fields.find((candidate) => candidate.fieldKey === gap.fieldKey);
      const mappedPurpose = validated.purposeOverrides[field?.fieldKey];
      return field
        && !field.alreadyFilled
        && !(mappedPurpose && availablePurposes.has(mappedPurpose))
        && (field.required || field.options.length > 0 || field.type === 'checkbox');
    }).map((gap) => ({
      fieldKey: String(gap.fieldKey),
      question: compactText(gap.question, 280),
      reason: compactText(gap.reason, 280),
    }));
    const usageEvents = [mappingResult.usage, gapResult.usage, reviewResult.usage];
    const usage = usageEvents.reduce((summary, item) => ({
      prompts: summary.prompts + Number(item.prompts || 0),
      inputCharacters: summary.inputCharacters + Number(item.inputCharacters || 0),
      outputCharacters: summary.outputCharacters + Number(item.outputCharacters || 0),
      contextUsageUnits: item.contextUsageUnits === null || summary.contextUsageUnits === null
        ? null
        : summary.contextUsageUnits + Number(item.contextUsageUnits || 0),
      durationMs: summary.durationMs + Number(item.durationMs || 0),
      apiCostUsd: 0,
    }), {
      prompts: 0,
      inputCharacters: 0,
      outputCharacters: 0,
      contextUsageUnits: 0,
      durationMs: 0,
      apiCostUsd: 0,
    });
    return {
      ...validated,
      gaps: validatedGaps,
      metadata: {
        runtime: 'chrome-gemini-nano',
        mode: 'on-device-multi-agent',
        agents: ROLE_NAMES,
        proposedMappings: (mapping.mappings || []).length,
        approvedMappings: validated.approved.length,
        rejectedMappings: validated.rejected.length,
        trustedHintMappings: validated.trustedHintMappings,
        usage,
        billing: 'on-device-no-token-charge',
        reviewedAt: new Date().toISOString(),
        summary: compactText(review.summary, 400),
      },
    };
  }

  function reset() {
    if (sessions) Object.values(sessions).forEach((session) => session?.destroy?.());
    sessions = null;
    preparingPromise = null;
    roleChains = Object.fromEntries(ROLE_NAMES.map((role) => [role, Promise.resolve()]));
  }

  function setRuntimeForTests(runtime) {
    reset();
    runtimeOverride = runtime;
  }

  const api = { availability, gatewayConfig, groupedInventory, plan, prepare, reset, setRuntimeForTests };
  root.NavaAgenticPlanner = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
