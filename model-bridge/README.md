# Subscription model companion

This localhost-only development companion lets the Chrome extension use an already authenticated Codex CLI or Claude Code session. It does not expose or copy provider credentials into Chrome.

1. Sign in to the CLI you intend to use (`codex login` or `claude auth login`). Choose the ChatGPT/Claude subscription login, not an API key.
2. From the repository root, run `npm run model:bridge`.
3. Copy the printed pairing token.
4. In the extension, open **Model runtime**, choose Codex or Claude, keep `http://127.0.0.1:4174`, paste the pairing token, and connect.

The companion binds only to `127.0.0.1`, requires a random bearer token, accepts only the three planner roles, limits request sizes and concurrency, and never logs prompts. Applicant values are removed by the extension before a request is sent. Claude runs with tools disabled. Codex runs ephemerally in an empty temporary directory under a read-only sandbox.

To exercise all three planner roles against fictional fields before opening Chrome, keep the companion running and use the same token in a second terminal:

```bash
NAVA_MODEL_BRIDGE_TOKEN="paste-token" NAVA_MODEL_PROVIDER=codex npm run model:smoke
```

This is for local evaluation, not production deployment. Calls consume the signed-in subscription's usage allowance and remain subject to the provider's plan limits and terms. The UI reports `$0.00 direct API-key cost`; that does not mean the subscription itself is free.
