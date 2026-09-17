const test = require('node:test');
const assert = require('node:assert/strict');

const catalog = require('../shared/program-catalog.js');

test('BenefitsCal programs are grouped into one application workflow', () => {
  const planned = catalog.planWorkflows(['calfresh', 'medical', 'calworks', 'wic', 'ihss']);
  assert.equal(planned.length, 3);
  const benefitsCal = planned.find((workflow) => workflow.workflowId === 'benefitscal');
  assert.deepEqual(benefitsCal.programIds, ['calfresh', 'medical', 'calworks']);
  assert.match(benefitsCal.name, /CalFresh/);
  assert.match(benefitsCal.name, /Medi-Cal/);
  assert.match(benefitsCal.name, /CalWORKs/);
});

test('known application routes and redirect origins match current sites', () => {
  const ihss = catalog.programDefinition('ihss');
  const wic = catalog.programDefinition('wic');
  assert.equal(ihss.url, 'https://riversideihss.org/IntakeApp');
  assert.deepEqual(ihss.allowedPathPrefixes, ['/IntakeApp']);
  assert.deepEqual(wic.allowedOrigins, ['https://www.ruhealth.org', 'https://ruhealth.org']);
  assert.deepEqual(wic.allowedPathPrefixes, ['/appointments/apply-4-wic-form']);
});

test('duplicate selections do not create duplicate workflows', () => {
  const planned = catalog.planWorkflows(['calfresh', 'calfresh', 'medical']);
  assert.equal(planned.length, 1);
  assert.deepEqual(planned[0].programIds, ['calfresh', 'medical']);
});
