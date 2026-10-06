const test = require('node:test');
const assert = require('node:assert/strict');

const policyRules = require('../sidepanel/application-policy.js');
const { hostLabel } = require('../sidepanel/panel-format.js');
const { PROGRAMS } = require('../shared/program-catalog.js');

const policy = policyRules.create({ programs: PROGRAMS, hostLabel });

function knownApplication(programId) {
  const program = PROGRAMS.find((item) => item.id === programId);
  return policy.attachApplicationPolicy({ id: `workflow:${programId}`, name: program.name, url: program.url, workflowId: program.workflowId });
}

test('a known application is approved only on its catalog origins and path prefixes', () => {
  const wic = knownApplication('wic');
  assert.deepEqual(wic.allowedOrigins, ['https://www.ruhealth.org', 'https://ruhealth.org']);
  assert.deepEqual(wic.allowedPathPrefixes, ['/appointments/apply-4-wic-form']);

  assert.doesNotThrow(() => policy.assertApprovedApplicationLocation(wic, 'https://ruhealth.org/appointments/apply-4-wic-form?step=2'));
  assert.doesNotThrow(() => policy.assertApprovedApplicationLocation(wic, 'https://www.ruhealth.org/appointments/apply-4-wic-form/contact'));
  assert.throws(
    () => policy.assertApprovedApplicationLocation(wic, 'https://evil.example/appointments/apply-4-wic-form'),
    /WIC tab left its approved site\. The assistant paused without reading or writing evil\.example\./,
  );
  assert.throws(
    () => policy.assertApprovedApplicationLocation(wic, 'https://www.ruhealth.org/appointments/apply-4-wic-form-lookalike'),
    /left its approved site/,
  );
  assert.doesNotThrow(() => policy.assertApprovedApplicationLocation({ name: 'Unsaved scan' }, 'https://anything.example/'));
});

test('an unknown site is pinned to the origin it was opened on, never to every path', () => {
  const attached = policy.attachApplicationPolicy({
    id: 'workflow:custom',
    url: 'https://forms.example.org/apply/start',
    allowedPathPrefixes: ['/', '/apply/'],
  });
  assert.equal(attached.workflowId, '');
  assert.deepEqual(attached.allowedOrigins, ['https://forms.example.org']);
  assert.deepEqual(attached.allowedPathPrefixes, ['/apply/']);
  assert.throws(() => policy.assertApprovedApplicationLocation(attached, 'https://forms.example.org/account'), /left its approved site/);
  assert.throws(() => policy.assertApprovedApplicationLocation({ ...attached, name: '' }, 'not a url'), /application tab left its approved site.*Current tab/);

  const benefitsCal = policy.attachApplicationPolicy({ id: 'x', url: 'https://benefitscal.com/somewhere' });
  assert.equal(benefitsCal.workflowId, 'benefitscal');
  assert.deepEqual(benefitsCal.allowedPathPrefixes, ['/ApplyForBenefits/']);
});

test('path prefixes match whole path segments unless they end in a slash', () => {
  assert.equal(policyRules.pathMatchesPrefix('/IntakeApp', '/IntakeApp'), true);
  assert.equal(policyRules.pathMatchesPrefix('/IntakeApp/household', '/IntakeApp'), true);
  assert.equal(policyRules.pathMatchesPrefix('/IntakeApplication', '/IntakeApp'), false);
  assert.equal(policyRules.pathMatchesPrefix('/ApplyForBenefits/begin', '/ApplyForBenefits/'), true);
  assert.equal(policyRules.pathMatchesPrefix('/ApplyForBenefitsX', '/ApplyForBenefits/'), false);
  assert.equal(policyRules.pathMatchesPrefix('', '/IntakeApp'), false);
  assert.equal(policyRules.pathMatchesPrefix('/IntakeApp', ''), false);
});

test('command locations ignore query order but detect any other navigation', () => {
  assert.equal(
    policyRules.commandLocation('https://site.example/form?b=2&a=1#step'),
    'https://site.example/form?a=1&b=2#step',
  );
  assert.equal(policyRules.urlSearch('https://site.example/form'), '');
  assert.equal(policyRules.urlOrigin('nope'), '');
  assert.equal(policyRules.urlPath('nope'), '');
  assert.equal(policyRules.urlHash('https://site.example/#x'), '#x');
  assert.doesNotThrow(() => policyRules.assertSameDocumentLocation('https://site.example/a?x=1&y=2', 'https://site.example/a?y=2&x=1'));
  assert.throws(
    () => policyRules.assertSameDocumentLocation('https://site.example/a', 'https://site.example/b'),
    /navigated before the assistant could safely read or write it/,
  );
  assert.throws(() => policyRules.assertSameDocumentLocation('https://site.example/a#one', 'https://site.example/a#two'), /navigated/);
});

test('scan checkpoints put one-time codes and unanswered fields ahead of CAPTCHA and final steps', () => {
  const kindOf = (response, fieldsFound = 3) => policyRules.checkpointFromScan(response, fieldsFound)?.kind ?? null;
  const gaps = { gaps: [{ fieldKey: 'x' }] };
  const captcha = { botCheckPresent: true, botCheckComplete: false };
  const otp = { oneTimeCodePresent: true, oneTimeCodeComplete: false };

  assert.equal(kindOf({ submitGate: { ...captcha, ...otp }, analysis: gaps }), 'otp');
  assert.equal(kindOf({ submitGate: captcha, analysis: gaps }), 'human_input');
  assert.equal(kindOf({ submitGate: captcha, navigationGate: { kind: 'final_review' } }), 'captcha');
  assert.equal(kindOf({ submitGate: { ...captcha, botCheckComplete: true }, navigationGate: { kind: 'next' } }), null);
  assert.equal(kindOf({ navigationGate: { kind: 'final_review', text: 'Sign and submit' } }), 'signature');
  assert.equal(kindOf({ navigationGate: { kind: 'final_review', reason: 'Affirm the declaration' } }), 'certification');
  assert.equal(kindOf({ navigationGate: { kind: 'final_review', text: 'Review' } }), 'final_review');
  assert.equal(kindOf({ navigationGate: { kind: 'none' } }, 0), 'navigation_unknown');
  assert.equal(kindOf({ navigationGate: { kind: 'next' } }, 0), null);
  assert.equal(kindOf({ navigationGate: { kind: 'manual' } }), 'navigation_unknown');
  assert.equal(policyRules.checkpointFromScan({ analysis: gaps }, 1).label, 'Caseworker answers required');

  const made = policyRules.checkpoint('handoff', 'Assigned');
  assert.equal(made.kind, 'handoff');
  assert.equal(made.label, 'Assigned');
  assert.ok(Number.isFinite(Date.parse(made.createdAt)));
});

test('automated runs stop at a per-workflow page limit', () => {
  assert.equal(policyRules.MAX_AUTOMATED_PAGES, 60);
  assert.equal(policyRules.DEFAULT_AUTOMATED_PAGES, 12);
  assert.equal(policyRules.automatedPageLimit({ workflowId: 'benefitscal' }), 60);
  assert.equal(policyRules.automatedPageLimit({ workflowId: 'riverside-ihss' }), 20);
  assert.equal(policyRules.automatedPageLimit({ workflowId: 'riverside-wic' }), 10);
  assert.equal(policyRules.automatedPageLimit({ workflowId: '' }), 12);
});
