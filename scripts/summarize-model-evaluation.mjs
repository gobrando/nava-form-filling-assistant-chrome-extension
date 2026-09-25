import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function summarize(document) {
  if (document?.schema !== 'nava.form-filling.model-evaluation.v1' || !Array.isArray(document.runs)) {
    throw new Error('Expected nava.form-filling.model-evaluation.v1 input.');
  }
  return document.runs.map((run) => {
    const metrics = run.metrics || {};
    const verifiedRate = metrics.attemptedWrites
      ? metrics.verifiedWrites / metrics.attemptedWrites
      : null;
    const coverage = metrics.visibleFields
      ? metrics.verifiedWrites / metrics.visibleFields
      : null;
    return {
      id: run.id,
      provider: run.provider,
      scenario: run.scenario,
      outcome: run.outcome,
      promptCount: metrics.promptCount ?? null,
      modelSeconds: Number.isFinite(metrics.modelDurationMs) ? metrics.modelDurationMs / 1000 : null,
      contextUsageUnits: metrics.contextUsageUnits ?? null,
      inputTokens: metrics.inputTokens ?? null,
      outputTokens: metrics.outputTokens ?? null,
      verifiedWrites: metrics.verifiedWrites ?? null,
      attemptedWrites: metrics.attemptedWrites ?? null,
      visibleFields: metrics.visibleFields ?? null,
      verifiedRate,
      coverage,
      reviewReady: Boolean(run.adjudication?.reviewReady),
    };
  });
}

function percent(value) {
  return value === null ? 'n/a' : `${(value * 100).toFixed(1)}%`;
}

function number(value, suffix = '') {
  return value === null ? 'n/a' : `${Number(value).toLocaleString(undefined, { maximumFractionDigits: 1 })}${suffix}`;
}

export function markdown(rows) {
  const header = '| Provider | Scenario | Outcome | Prompts | Model time | Usage | Verified | Coverage | Review-ready |\n| --- | --- | --- | ---: | ---: | --- | ---: | ---: | --- |';
  const body = rows.map((row) => {
    const usage = row.inputTokens === null
      ? `${number(row.contextUsageUnits)} context units`
      : `${number(row.inputTokens)} in / ${number(row.outputTokens)} out`;
    return `| ${row.provider} | ${row.scenario} | ${row.outcome} | ${number(row.promptCount)} | ${number(row.modelSeconds, 's')} | ${usage} | ${row.verifiedWrites}/${row.attemptedWrites} (${percent(row.verifiedRate)}) | ${row.verifiedWrites}/${row.visibleFields} (${percent(row.coverage)}) | ${row.reviewReady ? 'yes' : 'no'} |`;
  }).join('\n');
  return `${header}\n${body}`;
}

if (resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) {
  const path = resolve(process.argv[2] || 'evaluation/model-benchmark/runs.json');
  const document = JSON.parse(await readFile(path, 'utf8'));
  console.log(markdown(summarize(document)));
}
