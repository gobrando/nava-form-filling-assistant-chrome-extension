const test = require('node:test');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const { join } = require('node:path');

test('model evaluation summary calculates verified rate and coverage', async () => {
  const module = await import(pathToFileURL(join(process.cwd(), 'scripts/summarize-model-evaluation.mjs')));
  const [row] = module.summarize({
    schema: 'nava.form-filling.model-evaluation.v1',
    runs: [{ id: 'one', provider: 'test', scenario: 'form', outcome: 'done', metrics: { attemptedWrites: 8, verifiedWrites: 6, visibleFields: 12 } }],
  });
  assert.equal(row.verifiedRate, 0.75);
  assert.equal(row.coverage, 0.5);
  assert.match(module.markdown([row]), /6\/8 \(75\.0%\)/);
});
