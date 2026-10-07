// Syntax gate for `npm run check`: node --check on every first-party .js/.mjs/.cjs file, then a manifest.json parse, so new modules are covered without editing package.json.
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SKIPPED_DIRECTORIES = new Set(['node_modules', 'vendor', '.git', 'work']);
const SCRIPT_EXTENSION = /\.(?:js|mjs|cjs)$/;

function scriptFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return SKIPPED_DIRECTORIES.has(entry.name) ? [] : scriptFiles(path);
    return entry.isFile() && SCRIPT_EXTENSION.test(entry.name) ? [relative(root, path)] : [];
  });
}

const files = scriptFiles(root).sort();
const failures = files.filter((file) => {
  const result = spawnSync(process.execPath, ['--check', file], { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) process.stderr.write(`${file}\n${result.stderr}\n`);
  return result.status !== 0;
});

try {
  JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
} catch (error) {
  failures.push('manifest.json');
  process.stderr.write(`manifest.json: ${error.message}\n`);
}

console.log(`Syntax-checked ${files.length} scripts and manifest.json${failures.length ? `; ${failures.length} failed` : ''}.`);
if (process.argv.includes('--list')) console.log(files.join('\n'));
if (failures.length) process.exitCode = 1;
