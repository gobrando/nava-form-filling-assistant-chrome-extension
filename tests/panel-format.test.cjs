const test = require('node:test');
const assert = require('node:assert/strict');

const format = require('../sidepanel/panel-format.js');

test('HTML escaping covers every markup-significant character and empty values', () => {
  assert.equal(format.escapeHtml(`<a href="x">Tom & Jerry's</a>`), '&lt;a href=&quot;x&quot;&gt;Tom &amp; Jerry&#039;s&lt;/a&gt;');
  assert.equal(format.escapeHtml(null), '');
  assert.equal(format.escapeHtml(undefined), '');
  assert.equal(format.escapeHtml(0), '0');
  assert.equal(format.decoded(format.encoded('workflow:a&b c/d')), 'workflow:a&b c/d');
  assert.doesNotMatch(format.encoded('a"b<c>'), /["<>]/);
});

test('sensitive identifiers display only their last four digits', () => {
  assert.equal(format.displayValue('ssn', '123-45-6789'), '••••6789');
  assert.equal(format.displayValue('ein', '12-3456789'), '••••6789');
  assert.equal(format.displayValue('ssn', '12'), '••••');
  assert.equal(format.displayValue('ssn', null), '••••');
  assert.equal(format.displayValue('firstName', 'Ana'), 'Ana');
  assert.equal(format.displayValue('firstName', undefined), '');
});

test('verified provenance keeps the latest value per field and masks sensitive values', () => {
  const merged = format.mergeVerifiedProvenance(
    [{ fieldKey: 'a', value: 'first', source: 'page' }, null, { value: 'no key' }],
    [{ fieldKey: 'b', value: '98-7654321', sensitive: true }, { fieldKey: 'a', value: 'second', source: 'record' }],
  );
  assert.deepEqual(merged.map((item) => item.fieldKey), ['a', 'b']);
  assert.equal(merged[0].value, 'second');
  assert.equal(merged[0].source, 'record');
  assert.equal(merged[1].value, '••••4321');
  assert.equal(Object.hasOwn(merged[1], 'sensitive'), false);

  const previous = [{ fieldKey: 'kept', value: 'x' }];
  const observed = [{ fieldKey: 'new', value: 'y' }];
  assert.deepEqual(format.provenanceForScan(previous, observed, true).map((item) => item.fieldKey), ['kept', 'new']);
  assert.deepEqual(format.provenanceForScan(previous, observed, false).map((item) => item.fieldKey), ['new']);
  assert.deepEqual(format.provenanceForScan(undefined, undefined, true), []);
});

test('labels for hosts, providers, sources, timestamps, and progress', () => {
  assert.equal(format.hostLabel('https://www.ruhealth.org/appointments'), 'ruhealth.org');
  assert.equal(format.hostLabel('https://benefitscal.com/ApplyForBenefits/'), 'benefitscal.com');
  assert.equal(format.hostLabel('not a url'), 'Current tab');
  assert.equal(format.providerInitials('Salesforce Nonprofit Cloud'), 'SN');
  assert.equal(format.providerInitials('apricot 360'), 'A3');
  assert.equal(format.providerInitials(''), '');
  assert.equal(format.sourceLabel('record'), 'Record');
  assert.equal(format.sourceLabel('user'), 'You');
  assert.equal(format.sourceLabel('custom'), 'custom');
  assert.equal(format.formatTimestamp('not a date'), 'Unavailable');
  assert.equal(format.formatTimestamp('2026-01-02T03:04:05Z'), new Date('2026-01-02T03:04:05Z').toLocaleString());
  assert.deepEqual(
    ['ready_for_review', 'needs_attention', 'ready_to_fill', 'paused', 'handoff_pending', 'not_started']
      .map((status) => format.progressFor({ status })),
    [100, 55, 35, 20, 20, 8],
  );
});

test('model usage summary reports prompts, time, cost, and only the counters a provider reported', () => {
  assert.equal(format.agentUsageSummary(null), '');
  assert.equal(format.agentUsageSummary({}), '');
  assert.equal(
    format.agentUsageSummary({ usage: { prompts: 1, durationMs: 2500, apiCostUsd: 0 } }),
    '1 model prompt · 2.5s model time · $0.00 direct API-key cost',
  );
  assert.equal(
    format.agentUsageSummary({
      billing: 'subscription-allowance-no-direct-api-key',
      usage: { prompts: 3, durationMs: 0, apiCostUsd: 0.125, contextUsageUnits: 2048, inputTokens: 900, outputTokens: 40 },
    }),
    `3 model prompts · ${(2048).toLocaleString()} context units · 900 in / 40 out tokens · 0.0s model time · $0.13 direct API-key cost · subscription allowance used`,
  );
});

test('merged planner metadata sums usage and keeps unreported counters null', () => {
  const first = { runtime: 'one', usage: { prompts: 2, inputTokens: 10, outputTokens: 4, contextUsageUnits: 5, providerReportedCostUsd: 0.5 } };
  assert.deepEqual(format.mergeAgenticMetadata(null, first), { ...first, planCount: 1 });

  const second = { runtime: 'two', usage: { prompts: 1, inputCharacters: 30, durationMs: 100, apiCostUsd: 0.25, inputTokens: 5, outputTokens: 0, contextUsageUnits: 0, providerReportedCostUsd: 0 } };
  const merged = format.mergeAgenticMetadata({ ...first, planCount: 1 }, second);
  assert.equal(merged.runtime, 'two');
  assert.equal(merged.planCount, 2);
  assert.deepEqual(merged.usage, {
    prompts: 3,
    inputCharacters: 30,
    outputCharacters: 0,
    contextUsageUnits: 5,
    durationMs: 100,
    inputTokens: 15,
    outputTokens: 4,
    apiCostUsd: 0.25,
    providerReportedCostUsd: 0.5,
  });

  const unreported = format.mergeAgenticMetadata(merged, { usage: { prompts: 1, inputTokens: null, contextUsageUnits: undefined } });
  assert.equal(unreported.planCount, 3);
  assert.equal(unreported.usage.prompts, 4);
  assert.equal(unreported.usage.inputTokens, null);
  assert.equal(unreported.usage.outputTokens, null);
  assert.equal(unreported.usage.contextUsageUnits, null);
  assert.equal(unreported.usage.providerReportedCostUsd, null);
  assert.equal(format.mergeAgenticMetadata({ usage: { inputTokens: 1 } }, {}).usage.inputTokens, null);
});
