# Model providers and usage accounting

Date: 2026-09-23

## Shipped development runtimes

Version 0.10.0 runs the same schema-constrained field-mapper, gap-analyst, and independent-review roles through one of three selectable runtimes:

1. **Chrome on-device Gemini Nano.** Inference occurs in Chrome through the Prompt API.
2. **Codex subscription companion.** A loopback-only Node companion invokes `codex exec` using a Codex CLI session whose login status reports **ChatGPT**.
3. **Claude subscription companion.** The companion invokes Claude Code print mode using an eligible Claude subscription login. The current default is the `sonnet` alias.

A ChatGPT or Claude subscription is not an API key and does not expose a browser-callable subscription API. The companion is a local adapter around the providers' supported CLIs. It binds only to `127.0.0.1`, requires a random pairing token, rejects non-extension web origins, accepts only the three planner roles, caps body/output sizes and concurrency, and does not log prompt bodies. The token is stored only in `chrome.storage.session`.

The extension removes participant values before any model call. All runtimes receive only a bounded form inventory, option labels, the page domain, and names of available canonical source purposes. Returned mappings still pass the same local proposal/reviewer/schema/allowlist validation before a DOM write.

For the subscription paths, the companion also removes provider API-key variables from the child environment. Claude runs in safe mode with tools disabled and no session persistence. Codex runs ephemerally in an empty temporary directory with a read-only sandbox, ignored project rules, and a required output schema. Provider account credentials remain in the CLI's own credential store and never enter Chrome.

## Usage and cost display

Each application card records and displays aggregate, value-free usage for the current browser session:

- planning prompt count;
- Chrome context-usage units when exposed by the on-device runtime;
- input/output tokens when returned by the CLI;
- model execution time; and
- direct API-key cost in US dollars.

The on-device and subscription-companion paths report `$0.00 direct API-key cost`. That is not a claim that usage is free. The Chrome path consumes local bandwidth, storage, CPU/GPU, memory, battery, and electricity. Codex and Claude calls consume the signed-in plan's allowance and remain subject to its rate limits, credits, terms, and any subscription price. A provider-reported cost estimate is captured when available but is not treated as an invoice.

The sanitized activity log retains runtime, prompt count, token counts when known, duration, and direct API-key cost in integer microdollars. It never stores pairing tokens, prompts, model output, answers, participant values, or URLs with query strings.

## Production boundary

## Production boundary

The localhost companion is intended for internal development and evaluation. A production hosted-model path should be an authenticated, tenant-bound Nava gateway with organization policy, secret custody, model allowlists, rate limits, cost calculation, audit identifiers, retries, and budgets. It must keep the same value-minimized prompt and local validation boundary; no provider secret belongs in a public Chrome package.

This branch can also send that inventory to the Nava API. On the start screen, enter the API address and a tenant key. Those are saved as `navaApiBase` and `navaApiToken`. Optional `navaPlanModel` is one of `claude-opus-4-7`, `claude-opus-4-8`, `claude-sonnet-4-6`, `gpt-5.1`, or `gpt-5-mini`. When those keys are set, planning calls `POST /v1/plan` and Chrome's on-device model is not downloaded. If the API has a TypeSafe key, Jev decides the confident missing fields first and the generative model only sees the rest. Filling still happens in the caseworker's tab. The extension checks every returned mapping again before a DOM write. Do not put an Anthropic, OpenAI, or TypeSafe key in the extension.

References: [Using Codex with a ChatGPT plan](https://help.openai.com/en/articles/11369540-using-codex-with-your-chatgpt-plan), [Claude Code setup and authentication](https://code.claude.com/docs/en/getting-started), [Claude Code CLI structured output](https://code.claude.com/docs/en/cli-usage), and [Chrome Prompt API](https://developer.chrome.com/docs/ai/prompt-api).
