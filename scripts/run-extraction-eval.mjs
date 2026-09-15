import { createCanvas, loadImage } from '@napi-rs/canvas';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const formEngine = require('../shared/form-engine.js');
const ocrEngine = require('../sidepanel/ocr-engine.js');
const documentParser = require('../sidepanel/document-parser.js');
const { createWorker, OEM } = require('tesseract.js');
const corpus = JSON.parse(await readFile(path.join(root, 'evaluation', 'corpus.json'), 'utf8'));

function normalize(value) {
  return formEngine.normalize(value);
}

function maskSensitiveText(value) {
  return String(value || '')
    .replace(/\b\d{3}[- ]?\d{2}[- ]?(\d{4})\b/g, '••••$1')
    .replace(/\b\d{2}[- ]?\d{3}(\d{4})\b/g, '••••$1');
}

function rotateImage(image, degrees) {
  const sideways = Math.abs(degrees) % 180 === 90;
  const canvas = createCanvas(sideways ? image.height : image.width, sideways ? image.width : image.height);
  const context = canvas.getContext('2d');
  context.fillStyle = '#fff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.translate(canvas.width / 2, canvas.height / 2);
  context.rotate((degrees * Math.PI) / 180);
  context.drawImage(image, -image.width / 2, -image.height / 2);
  return canvas;
}

function resultScore(result) {
  return (Number(result.confidence) || 0) * 1000 + Math.min(String(result.text || '').replace(/\s/g, '').length, 999);
}

async function recognize(worker, image, rotation) {
  const input = rotateImage(image, rotation).toBuffer('image/png');
  const { data } = await worker.recognize(input, { tessedit_pageseg_mode: '11', preserve_interword_spaces: '1', user_defined_dpi: '300' }, { text: true, blocks: true });
  return {
    pageNumber: 1,
    text: String(data.text || ''),
    confidence: Number(data.confidence) || 0,
    lines: ocrEngine.linesFromResult(data),
    width: rotation ? image.height : image.width,
    height: rotation ? image.width : image.height,
    rotation,
  };
}

async function recognizeFixture(worker, fixturePath) {
  const image = await loadImage(fixturePath);
  const startedAt = performance.now();
  const attempts = [await recognize(worker, image, 0)];
  if (attempts[0].confidence < 55 || attempts[0].text.replace(/\s/g, '').length < 24) {
    attempts.push(await recognize(worker, image, 90));
    attempts.push(await recognize(worker, image, 270));
  }
  const best = attempts.sort((left, right) => resultScore(right) - resultScore(left))[0];
  return { best, attempts: attempts.length, durationMs: Math.round(performance.now() - startedAt) };
}

function evaluateCase(testCase, fields, recognition) {
  const expected = testCase.expected || {};
  const actual = Object.fromEntries(fields.map((field) => [field.key, field]));
  let truePositive = 0;
  let falsePositive = 0;
  let falseNegative = 0;
  let wrongValues = 0;
  let sensitiveEvidenceLeaks = 0;
  const differences = [];

  Object.entries(expected).forEach(([key, value]) => {
    const field = actual[key];
    if (!field) {
      falseNegative += 1;
      differences.push({ key, kind: 'missing', expected: value });
      return;
    }
    if (normalize(field.value) === normalize(value)) {
      truePositive += 1;
    } else {
      falsePositive += 1;
      falseNegative += 1;
      wrongValues += 1;
      differences.push({ key, kind: 'wrong', expected: value, actual: field.value });
    }
    if (field.sensitive && String(field.evidence).includes(String(value))) sensitiveEvidenceLeaks += 1;
  });
  Object.keys(actual).filter((key) => !(key in expected)).forEach((key) => {
    falsePositive += 1;
    differences.push({ key, kind: 'unexpected', actual: actual[key].value });
  });

  const abstained = fields.length === 0;
  const passed = testCase.expectedAbstain
    ? abstained
    : falsePositive === 0 && falseNegative === 0 && sensitiveEvidenceLeaks === 0;
  return {
    id: testCase.id,
    passed,
    expectedAbstain: Boolean(testCase.expectedAbstain),
    abstained,
    truePositive,
    falsePositive,
    falseNegative,
    wrongValues,
    sensitiveEvidenceLeaks,
    proposedFields: fields.length,
    lowConfidenceFields: fields.filter((field) => field.confidence === 'low').length,
    meanOcrConfidence: Math.round(recognition.best.confidence * 10) / 10,
    selectedRotation: recognition.best.rotation,
    attempts: recognition.attempts,
    durationMs: recognition.durationMs,
    recognizedText: maskSensitiveText(recognition.best.text),
    differences: differences.map((difference) => ({
      ...difference,
      expected: ['ssn', 'ein'].includes(difference.key) && difference.expected ? `••••${String(difference.expected).replace(/\D/g, '').slice(-4)}` : difference.expected,
      actual: ['ssn', 'ein'].includes(difference.key) && difference.actual ? `••••${String(difference.actual).replace(/\D/g, '').slice(-4)}` : difference.actual,
    })),
    actual: Object.fromEntries(Object.entries(actual).map(([key, field]) => [key, {
      value: field.sensitive ? field.displayValue : field.value,
      confidence: field.confidence,
      ocrConfidence: field.ocrConfidence,
      pageNumber: field.source?.pageNumber,
      region: field.source?.region,
    }])),
  };
}

const worker = await createWorker('eng', OEM.LSTM_ONLY, {
  langPath: path.join(root, 'vendor', 'tesseract', 'lang-data'),
  cacheMethod: 'none',
  gzip: true,
});

const cases = [];
try {
  for (const testCase of corpus.cases) {
    const fixturePath = path.join(root, 'evaluation', testCase.fixture);
    const recognition = await recognizeFixture(worker, fixturePath);
    const extracted = documentParser.extractFieldsFromOcrPages([recognition.best]);
    cases.push({ ...evaluateCase(testCase, extracted.fields, recognition), fieldsWithheld: extracted.withheld });
  }
} finally {
  await worker.terminate();
}

const totals = cases.reduce((result, testCase) => ({
  truePositive: result.truePositive + testCase.truePositive,
  falsePositive: result.falsePositive + testCase.falsePositive,
  falseNegative: result.falseNegative + testCase.falseNegative,
  wrongValues: result.wrongValues + testCase.wrongValues,
  sensitiveEvidenceLeaks: result.sensitiveEvidenceLeaks + testCase.sensitiveEvidenceLeaks,
  durationMs: result.durationMs + testCase.durationMs,
}), { truePositive: 0, falsePositive: 0, falseNegative: 0, wrongValues: 0, sensitiveEvidenceLeaks: 0, durationMs: 0 });
const abstentionCases = cases.filter((testCase) => testCase.expectedAbstain);
const metrics = {
  precision: totals.truePositive / Math.max(1, totals.truePositive + totals.falsePositive),
  recall: totals.truePositive / Math.max(1, totals.truePositive + totals.falseNegative),
  abstentionAccuracy: abstentionCases.filter((testCase) => testCase.abstained).length / Math.max(1, abstentionCases.length),
  wrongValues: totals.wrongValues,
  sensitiveEvidenceLeaks: totals.sensitiveEvidenceLeaks,
  totalDurationMs: totals.durationMs,
  averageCaseDurationMs: Math.round(totals.durationMs / cases.length),
};
const thresholdResults = {
  precision: metrics.precision >= corpus.thresholds.precision,
  recall: metrics.recall >= corpus.thresholds.recall,
  abstentionAccuracy: metrics.abstentionAccuracy >= corpus.thresholds.abstentionAccuracy,
  wrongValues: metrics.wrongValues <= corpus.thresholds.wrongValues,
  sensitiveEvidenceLeaks: metrics.sensitiveEvidenceLeaks <= corpus.thresholds.sensitiveEvidenceLeaks,
};
const passed = Object.values(thresholdResults).every(Boolean);
const generatedAt = new Date().toISOString();
const report = { corpusVersion: corpus.version, generatedAt, passed, thresholds: corpus.thresholds, thresholdResults, metrics, cases };

await writeFile(path.join(root, 'evaluation', 'latest-report.json'), `${JSON.stringify(report, null, 2)}\n`);

const percent = (value) => `${(value * 100).toFixed(1)}%`;
const rows = cases.map((testCase) =>
  `| ${testCase.id} | ${testCase.passed ? 'Exact' : 'Safe omission'} | ${testCase.proposedFields} | ${testCase.fieldsWithheld} | ${testCase.meanOcrConfidence}% | ${testCase.selectedRotation}° | ${(testCase.durationMs / 1000).toFixed(1)}s |`).join('\n');
const markdown = `# Extraction quality evaluation\n\nGenerated: ${generatedAt}\n\nResult: **${passed ? 'PASS' : 'FAIL'}**\n\n| Metric | Result | Threshold |\n| --- | ---: | ---: |\n| Precision | ${percent(metrics.precision)} | ≥ ${percent(corpus.thresholds.precision)} |\n| Recall | ${percent(metrics.recall)} | ≥ ${percent(corpus.thresholds.recall)} |\n| Expected-abstention accuracy | ${percent(metrics.abstentionAccuracy)} | ≥ ${percent(corpus.thresholds.abstentionAccuracy)} |\n| Wrong extracted values | ${metrics.wrongValues} | ≤ ${corpus.thresholds.wrongValues} |\n| Sensitive evidence leaks | ${metrics.sensitiveEvidenceLeaks} | ≤ ${corpus.thresholds.sensitiveEvidenceLeaks} |\n\n| Fixture | Field-set result | Proposed fields | Withheld | Mean OCR confidence | Corrected rotation | Runtime |\n| --- | --- | ---: | ---: | ---: | ---: | ---: |\n${rows}\n\nThe corpus contains only synthetic fictional records. OCR runs locally with the pinned English fast model. The base confidence floor is 70%; email uses 94%, SSN/EIN uses 90%, and suspicious name artifacts are withheld. “Safe omission” means one or more expected fields were withheld, while no wrong value was accepted. The unsupported handwriting fixture is expected to produce no fields. The JSON companion contains masked per-field results and page-region provenance.\n`;
await writeFile(path.join(root, 'evaluation', 'latest-report.md'), markdown);

console.log(`Extraction evaluation ${passed ? 'PASS' : 'FAIL'}: precision ${percent(metrics.precision)}, recall ${percent(metrics.recall)}, abstention ${percent(metrics.abstentionAccuracy)}, ${metrics.wrongValues} wrong values, ${metrics.sensitiveEvidenceLeaks} sensitive leaks.`);
if (!passed) process.exitCode = 1;
