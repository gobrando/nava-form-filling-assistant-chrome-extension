import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const engine = require('../shared/form-engine.js');
const planner = require('../shared/agentic-planner.js');

const token = String(process.env.NAVA_MODEL_BRIDGE_TOKEN || '').trim();
const provider = String(process.env.NAVA_MODEL_PROVIDER || 'codex').trim();
const endpoint = String(process.env.NAVA_MODEL_BRIDGE_URL || 'http://127.0.0.1:4174').trim();
if (!token) throw new Error('Set NAVA_MODEL_BRIDGE_TOKEN to the token printed by `npm run model:bridge`.');

planner.configure({
  kind: 'local-cli',
  provider,
  endpoint,
  token,
  model: provider === 'claude' ? 'sonnet' : '',
});

const result = await planner.plan({
  engine,
  page: { domain: 'benefits.example.gov' },
  rawFields: [
    { fieldKey: 'given-name', type: 'text', label: 'First name', required: true },
    { fieldKey: 'birth-date', type: 'date', label: 'Date of birth', required: true },
    { fieldKey: 'housing', type: 'select-one', label: 'Housing situation', required: true, options: [{ label: 'Stable' }, { label: 'Temporary' }] },
  ],
  participant: {
    participant: { name: { first: 'Synthetic' }, date_of_birth: '2000-01-02' },
  },
});

if (!result.metadata?.runtime?.startsWith(provider) || result.metadata.usage?.prompts !== 3) {
  throw new Error('The subscription planner did not complete all three model roles.');
}

process.stdout.write(`${JSON.stringify({
  ok: true,
  runtime: result.metadata.runtime,
  prompts: result.metadata.usage.prompts,
  approvedMappings: result.metadata.approvedMappings,
  rejectedMappings: result.metadata.rejectedMappings,
  gaps: result.gaps.length,
  inputTokens: result.metadata.usage.inputTokens,
  outputTokens: result.metadata.usage.outputTokens,
  directApiKeyCostUsd: result.metadata.usage.apiCostUsd,
}, null, 2)}\n`);

