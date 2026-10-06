// Model runtime for the three planner roles: provider configuration (Chrome on-device or paired loopback companion), availability, session preparation, and serialized per-role prompting with value-free usage counters.
(function installPlannerRuntime(root) {
  'use strict';

  // Bounds the companion model name: the global the inventory script installs first, or its CommonJS export under Node.
  const { compactText } = root.NavaPlannerInventory
    || (typeof module !== 'undefined' ? require('./planner-inventory.js') : undefined);

  const ROLE_NAMES = ['field_mapper', 'gap_analyst', 'form_reviewer'];
  const MODEL_OPTIONS = {
    expectedInputs: [{ type: 'text', languages: ['en'] }],
    expectedOutputs: [{ type: 'text', languages: ['en'] }],
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

  // Each on-device prompt runs in a fresh clone of the role's own session, so no prompt inherits
  // context from an earlier one; the clone is always destroyed.
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
    ROLE_NAMES,
    availability,
    configure,
    prepare,
    promptRole,
    reset,
    runtimeInfo,
    setBridgeFetchForTests,
    setRuntimeForTests,
  };

  root.NavaPlannerRuntime = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
