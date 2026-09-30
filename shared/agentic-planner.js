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
  let bridgeFetchOverride = null;
  let providerConfig = { kind: 'chrome-local' };

  function normalizeBridgeEndpoint(value) {
    let parsed;
    try {
      parsed = new URL(String(value || 'http://127.0.0.1:4174'));
    } catch {
      throw new Error('Enter a valid localhost model-companion address.');
    }
    if (parsed.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(parsed.hostname) || parsed.username || parsed.password) {
      throw new Error('The subscription model companion must use http://127.0.0.1 or http://localhost.');
    }
    parsed.pathname = parsed.pathname.replace(/\/$/, '');
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString().replace(/\/$/, '');
  }

  function normalizeProviderConfig(input = {}) {
    const kind = String(input.kind || 'chrome-local');
    if (kind === 'chrome-local') return { kind };
    if (kind !== 'local-cli') throw new Error('Choose a supported model runtime.');
    const provider = String(input.provider || '');
    if (!['codex', 'claude'].includes(provider)) throw new Error('Choose Codex or Claude for the local companion.');
    const token = String(input.token || '').trim();
    if (token.length < 24 || token.length > 512) throw new Error('Paste the pairing token printed by the local model companion.');
    return {
      kind,
      provider,
      endpoint: normalizeBridgeEndpoint(input.endpoint),
      token,
      model: provider === 'claude' ? compactText(input.model || 'sonnet', 80) : compactText(input.model || '', 120),
    };
  }

  function configure(input = {}) {
    const next = normalizeProviderConfig(input);
    const changed = JSON.stringify(next) !== JSON.stringify(providerConfig);
    if (changed) reset();
    providerConfig = next;
    return runtimeInfo();
  }

  function runtimeInfo() {
    if (providerConfig.kind === 'local-cli') {
      const providerName = providerConfig.provider === 'codex' ? 'Codex CLI' : 'Claude Code';
      return {
        kind: providerConfig.kind,
        provider: providerConfig.provider,
        endpoint: providerConfig.endpoint,
        model: providerConfig.model,
        title: `${providerName} subscription`,
        detail: `${providerName} runs through the paired localhost companion and the signed-in subscription allowance.`,
      };
    }
    return {
      kind: 'chrome-local',
      title: 'Chrome on-device AI',
      detail: 'Three separate Gemini Nano sessions run locally in Chrome.',
    };
  }

  function languageModel() {
    return runtimeOverride || root.LanguageModel || null;
  }

  function bridgeFetch() {
    return bridgeFetchOverride || root.fetch?.bind(root) || null;
  }

  async function bridgeRequest(path, options = {}) {
    const fetcher = bridgeFetch();
    if (!fetcher) throw new Error('This browser cannot connect to the local model companion.');
    let response;
    try {
      response = await fetcher(`${providerConfig.endpoint}${path}`, {
        ...options,
        headers: {
          Authorization: `Bearer ${providerConfig.token}`,
          ...(options.body ? { 'Content-Type': 'application/json' } : {}),
          ...(options.headers || {}),
        },
      });
    } catch {
      throw new Error('The local model companion is not reachable. Start `npm run model:bridge`, then use the pairing token it prints.');
    }
    let payload = {};
    try {
      payload = await response.json();
    } catch {
      // A structured error below is safer than exposing raw companion output.
    }
    if (!response.ok || !payload.ok) {
      throw new Error(payload.error || `The local model companion returned HTTP ${response.status}.`);
    }
    return payload;
  }

  function normalizedAvailability(value) {
    const status = String(value || '').toLowerCase();
    if (['available', 'readily'].includes(status)) return 'available';
    if (['downloadable', 'after-download'].includes(status)) return 'downloadable';
    if (status === 'downloading') return 'downloading';
    return 'unavailable';
  }

  async function availability() {
    if (providerConfig.kind === 'local-cli') {
      try {
        const result = await bridgeRequest('/health');
        const provider = result.providers?.[providerConfig.provider];
        return provider?.installed && provider?.subscription ? 'available' : 'unavailable';
      } catch {
        return 'unavailable';
      }
    }
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
          if (providerConfig.kind === 'local-cli') {
            throw new Error(`The paired ${providerConfig.provider === 'codex' ? 'Codex CLI' : 'Claude Code'} companion is unavailable. Start \`npm run model:bridge\`, confirm the CLI is signed in with the intended subscription, and reconnect.`);
          }
          throw new Error('The on-device language model is unavailable. Use Chrome 138 or newer on a supported desktop and enable Chrome built-in AI before starting an agentic run.');
        }
        onProgress?.({
          phase: status === 'available' ? 'starting' : 'download',
          progress: 0,
          provider: providerConfig.kind === 'local-cli' ? providerConfig.provider : 'chrome-local',
        });
        if (providerConfig.kind === 'local-cli') {
          sessions = { bridge: true };
        } else {
          const created = await Promise.all(ROLE_NAMES.map(async (role) => [role, await createSession(role, onProgress)]));
          sessions = Object.fromEntries(created);
        }
        onProgress?.({ phase: 'ready', progress: 1 });
        return { status: 'ready', agents: ROLE_NAMES };
      })().finally(() => {
        preparingPromise = null;
      });
    }
    return preparingPromise;
  }

  // A numeric session reading (Chrome exposes these as numbers); anything non-finite is unknown.
  function finiteNumber(value) {
    return Number.isFinite(Number(value)) ? Number(value) : null;
  }

  // A usage figure the companion may omit: absent (null/undefined) stays unknown instead of becoming 0.
  function reportedNumber(value) {
    return value === null || value === undefined ? null : finiteNumber(value);
  }

  async function promptCompanionRole(role, prompt, responseConstraint) {
    const startedAt = Date.now();
    const result = await bridgeRequest('/v1/role', {
      method: 'POST',
      body: JSON.stringify({
        provider: providerConfig.provider,
        model: providerConfig.model,
        role,
        systemPrompt: SYSTEM_PROMPTS[role],
        prompt,
        responseSchema: responseConstraint,
      }),
    });
    return {
      text: result.text,
      usage: {
        role,
        prompts: 1,
        inputCharacters: prompt.length,
        outputCharacters: String(result.text || '').length,
        inputTokens: reportedNumber(result.usage?.inputTokens),
        outputTokens: reportedNumber(result.usage?.outputTokens),
        contextUsageUnits: null,
        contextWindow: null,
        durationMs: Number(result.usage?.durationMs || (Date.now() - startedAt)),
        apiCostUsd: 0,
        providerReportedCostUsd: reportedNumber(result.usage?.providerReportedCostUsd),
      },
    };
  }

  // Each on-device prompt runs in a fresh clone of the role's session, so roles never share context.
  async function promptOnDeviceRole(role, prompt, responseConstraint) {
    const session = await sessions[role].clone();
    const startedAt = Date.now();
    const contextUsageBefore = finiteNumber(session.contextUsage);
    try {
      const text = await session.prompt(prompt, { responseConstraint });
      const contextUsageAfter = finiteNumber(session.contextUsage);
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
          contextWindow: finiteNumber(session.contextWindow),
          durationMs: Date.now() - startedAt,
          inputTokens: null,
          outputTokens: null,
          apiCostUsd: 0,
          providerReportedCostUsd: null,
        },
      };
    } finally {
      session.destroy();
    }
  }

  // Prompts are serialized per role, so one role's session is never prompted concurrently.
  function promptRole(role, prompt, responseConstraint) {
    const run = roleChains[role]
      .catch(() => undefined)
      .then(() => (providerConfig.kind === 'local-cli'
        ? promptCompanionRole(role, prompt, responseConstraint)
        : promptOnDeviceRole(role, prompt, responseConstraint)));
    roleChains[role] = run.catch(() => undefined);
    return run;
  }

  function compactText(value, limit = 240) {
    return String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit);
  }

  // The bounded, value-free description of one page control that a model is allowed to see.
  // A singleton group keeps its own writable field key; a real group is keyed by the group.
  function inventoryEntry(field, singletonGroup) {
    return {
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
  }

  function standaloneOptions(field) {
    return (field.options || []).slice(0, 80).map((option) => compactText(option.label || option.value, 120));
  }

  // Folds one radio/checkbox group member into the group's entry: the group is required or filled
  // when any member is, and each member contributes its option text.
  function mergeGroupMember(groupEntry, memberEntry, field) {
    groupEntry.required = groupEntry.required || memberEntry.required;
    groupEntry.alreadyFilled = groupEntry.alreadyFilled || memberEntry.alreadyFilled;
    groupEntry.question = groupEntry.question || memberEntry.question;
    groupEntry.purposeHint = groupEntry.purposeHint || memberEntry.purposeHint;
    groupEntry.options.push(compactText(field.optionLabel || field.optionValue || field.label, 120));
    return groupEntry;
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
      const entry = inventoryEntry(field, singletonGroup);
      if (!field.groupKey || singletonGroup) {
        entry.options = standaloneOptions(field);
        singles.push(entry);
        return;
      }
      groups.set(field.groupKey, mergeGroupMember(groups.get(field.groupKey) || entry, entry, field));
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

  // Everything a planner (local roles or the shared gateway) may see: the bounded page inventory with
  // participant values redacted, and the source purposes on file without their values.
  function planningInventory(engine, participant, rawFields) {
    const fields = redactSourceValues(engine, participant, groupedInventory(rawFields));
    const sources = sourceInventory(engine, participant);
    return { fields, sources };
  }

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
    const companion = providerConfig.kind === 'local-cli';
    return {
      runtime: companion ? `${providerConfig.provider}-cli-subscription` : 'chrome-gemini-nano',
      mode: companion ? 'localhost-subscription-multi-agent' : 'on-device-multi-agent',
      provider: companion ? providerConfig.provider : 'chrome-local',
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

  function reset() {
    if (sessions) Object.values(sessions).forEach((session) => session?.destroy?.());
    sessions = null;
    preparingPromise = null;
    roleChains = Object.fromEntries(ROLE_NAMES.map((role) => [role, Promise.resolve()]));
  }

  function setRuntimeForTests(runtime) {
    reset();
    providerConfig = { kind: 'chrome-local' };
    runtimeOverride = runtime;
  }

  function setBridgeFetchForTests(fetcher) {
    reset();
    bridgeFetchOverride = fetcher;
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
