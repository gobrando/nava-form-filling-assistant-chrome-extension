const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');

test('manifest is valid MV3 and loads the side panel', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.side_panel.default_path, 'sidepanel/index.html');
  assert.ok(manifest.permissions.includes('sidePanel'));
});

test('page agent exposes no submit command and never invokes requestSubmit', () => {
  const source = fs.readFileSync(path.join(root, 'content/form-agent.js'), 'utf8');
  assert.doesNotMatch(source, /requestSubmit\s*\(/);
  assert.doesNotMatch(source, /\.submit\s*\(/);
  assert.doesNotMatch(source, /NAVA_SUBMIT\b/);
  assert.match(source, /submitGateStatus/);
});

test('cross-page automation only exposes gated advance and stops on final actions', () => {
  const agent = fs.readFileSync(path.join(root, 'content/form-agent.js'), 'utf8');
  const panel = fs.readFileSync(path.join(root, 'sidepanel/sidepanel.js'), 'utf8');
  assert.match(agent, /NAVA_ADVANCE/);
  assert.match(agent, /SAFE_ADVANCE_LABELS/);
  assert.match(agent, /FINAL_ACTION_PATTERN/);
  assert.match(agent, /certif\|attest\|affirm/);
  assert.match(agent, /decision\.gate\.kind !== 'next'/);
  assert.match(panel, /MAX_AUTOMATED_PAGES = 12/);
  assert.match(panel, /visitedSignatures/);
  assert.doesNotMatch(panel, /NAVA_SUBMIT\b/);

  const patternLiteral = agent.match(/const FINAL_PAGE_PATTERN = (\/.*\/i);/)?.[1];
  assert.ok(patternLiteral, 'final-page pattern should be declared');
  const finalPagePattern = Function(`return ${patternLiteral}`)();
  assert.doesNotMatch('Fill in and submit your application', finalPagePattern);
  assert.match('Review and submit', finalPagePattern);
  assert.match('Certification and signature', finalPagePattern);
});

test('multi-page fixture marks itself safe for navigation but retains a submit guard', () => {
  const html = fs.readFileSync(path.join(root, 'demo/multi-page.html'), 'utf8');
  const script = fs.readFileSync(path.join(root, 'demo/multi-page.js'), 'utf8');
  assert.match(html, /data-nava-demo-flow="true"/);
  assert.match(script, />Next</);
  assert.match(script, />Save and continue</);
  assert.match(script, /Review and submit/);
  assert.match(script, /type="submit">Submit application/);
});

test('extension contains no remote scripts or inline executable script', () => {
  const html = fs.readFileSync(path.join(root, 'sidepanel/index.html'), 'utf8');
  assert.doesNotMatch(html, /<script[^>]+https?:/i);
  assert.doesNotMatch(html, /<script>[^<]/i);
});

test('document intake uses only bundled parsers and never persists the raw file', () => {
  const html = fs.readFileSync(path.join(root, 'sidepanel/index.html'), 'utf8');
  const parser = fs.readFileSync(path.join(root, 'sidepanel/document-parser.js'), 'utf8');
  const panel = fs.readFileSync(path.join(root, 'sidepanel/sidepanel.js'), 'utf8');

  assert.match(html, /vendor\/fflate\.min\.js/);
  assert.match(parser, /vendor\/pdf\.min\.mjs/);
  assert.doesNotMatch(parser, /fetch\s*\(|XMLHttpRequest|WebSocket/);
  assert.doesNotMatch(panel, /clientDocument[^\n]+storage/);
  assert.ok(fs.existsSync(path.join(root, 'vendor/pdf.worker.min.mjs')));
  assert.ok(fs.existsSync(path.join(root, 'vendor/licenses/PDFJS-LICENSE.txt')));
  assert.ok(fs.existsSync(path.join(root, 'vendor/licenses/FFLATE-LICENSE.txt')));
});

test('OCR uses only bundled assets, enforces resource limits, and requires field review', () => {
  const html = fs.readFileSync(path.join(root, 'sidepanel/index.html'), 'utf8');
  const ocr = fs.readFileSync(path.join(root, 'sidepanel/ocr-engine.js'), 'utf8');
  const parser = fs.readFileSync(path.join(root, 'sidepanel/document-parser.js'), 'utf8');
  const panel = fs.readFileSync(path.join(root, 'sidepanel/sidepanel.js'), 'utf8');

  assert.match(html, /ocr-engine\.js/);
  assert.match(ocr, /vendor\/tesseract\/tesseract\.esm\.min\.js/);
  assert.match(ocr, /MAX_OCR_PAGES = 8/);
  assert.match(ocr, /MAX_PAGE_PIXELS = 8_000_000/);
  assert.match(ocr, /MAX_TOTAL_PIXELS = 32_000_000/);
  assert.match(ocr, /MAX_OCR_ATTEMPTS = 10/);
  assert.doesNotMatch(ocr, /https?:\/\//i);
  assert.match(parser, /reviewRequired: true/);
  assert.match(panel, /field\.reviewRequired \? '' : 'checked'/);
  assert.match(panel, /image\/png/);

  [
    'vendor/tesseract/tesseract.esm.min.js',
    'vendor/tesseract/worker.min.js',
    'vendor/tesseract/core/tesseract-core-lstm.wasm.js',
    'vendor/tesseract/core/tesseract-core-lstm.wasm',
    'vendor/tesseract/lang-data/eng.traineddata.gz',
    'vendor/licenses/TESSERACT-JS-LICENSE.txt',
    'vendor/licenses/TESSERACT-CORE-LICENSE.txt',
    'vendor/licenses/TESSDATA-FAST-LICENSE.txt',
  ].forEach((relativePath) => assert.ok(fs.existsSync(path.join(root, relativePath)), `${relativePath} should be bundled`));
  assert.ok(fs.existsSync(path.join(root, 'demo/fixtures/sample-client-scan.pdf')));
});

test('managed connector is read-only and stores only validated configuration', () => {
  const background = fs.readFileSync(path.join(root, 'background.js'), 'utf8');
  const mock = fs.readFileSync(path.join(root, 'connector-service/mock-server.mjs'), 'utf8');
  const panel = fs.readFileSync(path.join(root, 'sidepanel/sidepanel.js'), 'utf8');

  assert.match(background, /connectorEngine\.validateMappings\(message\.config, schema\)/);
  assert.match(background, /chrome\.storage\.local\.set/);
  assert.match(background, /method: 'GET'/);
  assert.match(background, /credentials: 'include'/);
  assert.doesNotMatch(background, /method:\s*['"](?:POST|PUT|PATCH|DELETE)['"]/);
  assert.match(mock, /server\.listen\(port, '127\.0\.0\.1'/);
  assert.match(mock, /Read-only mock: GET requests only/);
  assert.match(panel, /Confirm this client/);
  assert.match(panel, /confirm-connector-record/);
});
