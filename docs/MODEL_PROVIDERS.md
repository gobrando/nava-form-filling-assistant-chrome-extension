# Model providers and usage accounting

Date: 2026-09-23

## What runs today

Version 0.9.4 uses Chrome's built-in Gemini Nano Prompt API for all three planning roles: field mapper, gap analyst, and independent reviewer. Inference occurs on the caseworker's device. Participant values are withheld from model prompts; the model receives a bounded form-field inventory and the names of source purposes that are available.

The installed extension does **not** currently call Anthropic, Google Cloud, Vertex AI, or another hosted model service. It does not contain or accept a model-provider API key.

Each application card now records and displays aggregate, value-free usage for the current browser session:

- planning prompt count;
- bounded input/output character counts in session state;
- Chrome context-usage units when the runtime exposes them;
- model execution time; and
- model API cost in US dollars.

The activity log records prompt count, model duration, runtime name, and API cost in integer microdollars. It never records prompts, answers, participant values, URLs with query strings, or model output.

For the on-device runtime, model API cost is `$0.00`. That is a billing statement, not a claim that the run consumes no resources: the device still incurs model-download bandwidth, storage, CPU/GPU time, memory, battery, and electricity.

## Cloud Claude support

The same constrained planner can use a Claude model, but the safe production shape is:

```text
Chrome extension
  -> authenticated Nava model gateway
      -> organization-approved Claude model
          -> schema-constrained mapper/gap/reviewer results
      <- provider usage counters and calculated cost
  <- reviewed plan with no participant values
```

Do not put an Anthropic API key in the extension or call the provider directly from a public browser package. A Nava-managed gateway should own credentials, organization policy, model selection, rate limits, audit identifiers, retries, and cost calculation. The extension should send the same value-minimized field inventory used by the local planner, require the same JSON schemas, and run every returned mapping through the existing local validator before a DOM write.

Required controls for a hosted provider adapter:

1. explicit organization-admin enablement and a visible local/cloud runtime indicator;
2. authenticated, tenant-bound requests with no provider secret in Chrome;
3. no raw participant values, documents, form answers, or sensitive evidence in planning prompts;
4. strict request/response size limits, timeouts, retry limits, and schema validation;
5. server-side model allowlisting and deprecation management;
6. provider usage returned as input, cache, and output token counts plus calculated microdollar cost;
7. value-free audit events and per-organization budgets; and
8. fail-closed behavior when the gateway, model, or reviewer is unavailable.

This cloud-provider adapter is an implementation milestone, not a capability shipped in version 0.9.4.

References: [Chrome Prompt API](https://developer.chrome.com/docs/ai/prompt-api), [Chrome extensions and AI](https://developer.chrome.com/docs/extensions/ai), [Anthropic pricing and usage fields](https://docs.anthropic.com/en/docs/about-claude/pricing), and [Anthropic model lifecycle](https://docs.anthropic.com/en/docs/about-claude/model-deprecations).
