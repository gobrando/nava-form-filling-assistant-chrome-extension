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

test('an unanswered benefits checkbox becomes an explicit yes/no gap', () => {
  const analysis = engine.buildAnalysis([{
    fieldKey: 'appointment-phone',
    purpose: 'wicAppointmentPhone',
    type: 'checkbox',
    label: 'Virtual (phone)',
    checked: false,
    value: '',
  }], {});

  assert.equal(analysis.gaps.length, 1);
  assert.equal(analysis.gaps[0].fieldKey, 'appointment-phone');
  assert.equal(analysis.gaps[0].inputType, 'choice');
  assert.deepEqual(analysis.gaps[0].options, [
    { value: 'yes', label: 'Yes' },
    { value: 'no', label: 'No' },
  ]);
  assert.match(analysis.gaps[0].question, /select virtual \(phone\)/i);
});

test('related unanswered WIC checkboxes become one select-all-that-apply question', () => {
  const analysis = engine.buildAnalysis([
    {
      fieldKey: 'appointment-in-person',
      purpose: 'wicAppointmentInPerson',
      type: 'checkbox',
      label: 'In-Person',
      optionLabel: 'In-Person',
      decisionGroupKey: 'wic:appointment-methods',
      decisionGroupQuestion: 'Which WIC appointment methods should be authorized?',
      checked: false,
      value: '',
    },
    {
      fieldKey: 'appointment-phone',
      purpose: 'wicAppointmentPhone',
      type: 'checkbox',
      label: 'Virtual (phone)',
      optionLabel: 'Virtual (phone)',
      decisionGroupKey: 'wic:appointment-methods',
      decisionGroupQuestion: 'Which WIC appointment methods should be authorized?',
      checked: false,
      value: '',
    },
    {
      fieldKey: 'appointment-video',
      purpose: 'wicAppointmentVideo',
      type: 'checkbox',
      label: 'Telehealth (video)',
      optionLabel: 'Telehealth (video)',
      decisionGroupKey: 'wic:appointment-methods',
      decisionGroupQuestion: 'Which WIC appointment methods should be authorized?',
      checked: false,
      value: '',
    },
  ], {});

  assert.equal(analysis.gaps.length, 1);
  assert.equal(analysis.gaps[0].inputType, 'multi_choice');
  assert.equal(analysis.gaps[0].members.length, 3);
  assert.deepEqual(analysis.gaps[0].options.map((option) => option.label), [
    'In-Person',
    'Virtual (phone)',
    'Telehealth (video)',
  ]);
});
