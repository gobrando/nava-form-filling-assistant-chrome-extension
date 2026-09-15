import { copyFile, mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const destination = path.join(root, 'vendor', 'tesseract');
const coreDestination = path.join(destination, 'core');
const licenseDestination = path.join(root, 'vendor', 'licenses');

await Promise.all([
  mkdir(coreDestination, { recursive: true }),
  mkdir(path.join(destination, 'lang-data'), { recursive: true }),
  mkdir(licenseDestination, { recursive: true }),
]);

const copies = [
  ['node_modules/tesseract.js/dist/tesseract.esm.min.js', 'vendor/tesseract/tesseract.esm.min.js'],
  ['node_modules/tesseract.js/dist/worker.min.js', 'vendor/tesseract/worker.min.js'],
  ['node_modules/tesseract.js/LICENSE.md', 'vendor/licenses/TESSERACT-JS-LICENSE.txt'],
  ['node_modules/tesseract.js-core/LICENSE', 'vendor/licenses/TESSERACT-CORE-LICENSE.txt'],
  ['node_modules/tesseract.js-core/tesseract-core-lstm.wasm.js', 'vendor/tesseract/core/tesseract-core-lstm.wasm.js'],
  ['node_modules/tesseract.js-core/tesseract-core-lstm.wasm', 'vendor/tesseract/core/tesseract-core-lstm.wasm'],
  ['node_modules/tesseract.js-core/tesseract-core-simd-lstm.wasm.js', 'vendor/tesseract/core/tesseract-core-simd-lstm.wasm.js'],
  ['node_modules/tesseract.js-core/tesseract-core-simd-lstm.wasm', 'vendor/tesseract/core/tesseract-core-simd-lstm.wasm'],
  ['node_modules/tesseract.js-core/tesseract-core-relaxedsimd-lstm.wasm.js', 'vendor/tesseract/core/tesseract-core-relaxedsimd-lstm.wasm.js'],
  ['node_modules/tesseract.js-core/tesseract-core-relaxedsimd-lstm.wasm', 'vendor/tesseract/core/tesseract-core-relaxedsimd-lstm.wasm'],
];

for (const [source, target] of copies) {
  await copyFile(path.join(root, source), path.join(root, target));
}

const languagePath = path.join(destination, 'lang-data', 'eng.traineddata.gz');
try {
  const language = await stat(languagePath);
  if (language.size < 100000) throw new Error('English trained data is unexpectedly small.');
} catch (error) {
  throw new Error(`Missing vendor/tesseract/lang-data/eng.traineddata.gz. Download the pinned English fast model before packaging. ${error.message}`);
}

console.log(`Bundled ${copies.length} OCR runtime assets and verified the English trained-data file.`);
