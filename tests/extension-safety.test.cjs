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
