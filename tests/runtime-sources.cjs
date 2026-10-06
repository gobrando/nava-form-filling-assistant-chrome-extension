// Runtime source resolver for source-level tests: reads each extension context's first-party code in the order Chrome loads it, so assertions follow code across module splits.
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

/** Side-panel scripts from sidepanel/index.html in load order, without shared engines or vendored code. */
function sidePanelScripts() {
  const html = read('sidepanel/index.html');
  return [...html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)]
    .map((match) => match[1].split(/[?#]/)[0])
    .filter((src) => !src.startsWith('../shared/') && !src.startsWith('../vendor/'))
    .map((src) => path.posix.join('sidepanel', src));
}

function sidePanelSource() {
  return sidePanelScripts().map(read).join('\n');
}

/** background.js followed by the service-worker modules it imports from ./background/. */
function serviceWorkerSource() {
  const background = read('background.js');
  const modules = [...background.matchAll(/^\s*import\s+(?:[^'"]*?\s+from\s+)?['"](\.\/background\/[^'"]+)['"]/gm)]
    .map((match) => match[1].replace(/^\.\//, ''));
  return [background, ...modules.map(read)].join('\n');
}

/** Manifest content scripts that live under content/, in manifest order. */
function pageAgentSource() {
  const manifest = JSON.parse(read('manifest.json'));
  return (manifest.content_scripts || [])
    .flatMap((entry) => entry.js || [])
    .filter((file) => file.startsWith('content/'))
    .map(read)
    .join('\n');
}

module.exports = { sidePanelScripts, sidePanelSource, serviceWorkerSource, pageAgentSource };
