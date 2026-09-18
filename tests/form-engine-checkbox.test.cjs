const test = require('node:test');
const assert = require('node:assert/strict');
const engine = require('../shared/form-engine.js');

test('standalone boolean checkboxes converge after true and false writes', () => {
  const falseAnalysis = engine.buildAnalysis([{
    fieldKey: 'pregnant',
    purpose: 'pregnant',
    type: 'checkbox',
    label: 'Pregnant',
    checked: false,
    value: '',
  }], { pregnant: false });
  assert.equal(falseAnalysis.assignments.length, 0);
  assert.equal(falseAnalysis.observed[0].value, 'no');

  const trueAnalysis = engine.buildAnalysis([{
    fieldKey: 'child-under-five',
    purpose: 'wicChildUnderFive',
    type: 'checkbox',
    label: 'Child under five',
    checked: true,
    value: 'Children/Toddler 0-5',
  }], { programData: { wic: { childUnderFive: true } } });
  assert.equal(trueAnalysis.assignments.length, 0);
  assert.equal(trueAnalysis.observed[0].value, 'yes');

  const changedAnalysis = engine.buildAnalysis([{
    fieldKey: 'pregnant',
    purpose: 'pregnant',
    type: 'checkbox',
    label: 'Pregnant',
    checked: true,
    value: 'Pregnant',
  }], { pregnant: false });
  assert.equal(changedAnalysis.assignments.length, 1);
  assert.equal(changedAnalysis.assignments[0].value, 'no');
});

test('unchecked exclusive checkbox groups retain their real option values', () => {
  const analysis = engine.buildAnalysis([
    {
      fieldKey: 'texts-yes',
      groupKey: 'wic:receive-texts',
      purpose: 'canReceiveTexts',
      type: 'radio',
      question: 'Can you receive text messages?',
      optionLabel: 'Yes',
      optionValue: 'Yes',
      checked: false,
      value: '',
    },
    {
      fieldKey: 'texts-no',
      groupKey: 'wic:receive-texts',
      purpose: 'canReceiveTexts',
      type: 'radio',
      question: 'Can you receive text messages?',
      optionLabel: 'No',
      optionValue: 'No',
      checked: false,
      value: '',
    },
  ], { programData: { wic: { canReceiveTexts: false } } });

  assert.equal(analysis.assignments.length, 1);
  assert.equal(analysis.assignments[0].fieldKey, 'wic:receive-texts');
  assert.equal(analysis.assignments[0].value, 'No');
});
