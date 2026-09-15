import { createCanvas, PDFDocument } from '@napi-rs/canvas';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const corpus = JSON.parse(await readFile(path.join(root, 'evaluation', 'corpus.json'), 'utf8'));
const fixtureDirectory = path.join(root, 'evaluation', 'fixtures');
await mkdir(fixtureDirectory, { recursive: true });

function seededRandom(seed) {
  let value = seed >>> 0;
  return () => {
    value = (value * 1664525 + 1013904223) >>> 0;
    return value / 0x100000000;
  };
}

function prepareCanvas(testCase) {
  const canvas = createCanvas(testCase.width, testCase.height);
  const context = canvas.getContext('2d');
  context.fillStyle = testCase.background;
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = testCase.foreground;
  context.strokeStyle = '#9a9a9a';
  context.lineWidth = 2;
  context.font = testCase.font;
  context.textBaseline = 'middle';
  return { canvas, context };
}

function drawLines(testCase, context) {
  const margin = 90;
  const gap = 92;
  testCase.lines.forEach((line, index) => {
    const y = 100 + index * gap;
    context.font = index === 0 ? `bold ${testCase.font}` : testCase.font;
    context.fillText(line, margin, y);
  });
}

function drawTable(testCase, context) {
  const left = 70;
  const top = 120;
  const labelWidth = 470;
  const valueWidth = testCase.width - left * 2 - labelWidth;
  const rowHeight = 120;
  context.font = `bold ${testCase.font}`;
  context.fillText('FICTIONAL BUSINESS RECORD', left, 60);
  context.font = testCase.font;
  testCase.rows.forEach(([label, value], index) => {
    const y = top + index * rowHeight;
    context.strokeRect(left, y, labelWidth, rowHeight);
    context.strokeRect(left + labelWidth, y, valueWidth, rowHeight);
    context.fillText(label, left + 20, y + rowHeight / 2);
    context.fillText(value, left + labelWidth + 20, y + rowHeight / 2);
  });
}

function drawHandwriting(testCase, context) {
  context.font = testCase.font;
  testCase.lines.forEach((line, index) => {
    context.save();
    context.translate(100, 150 + index * 155);
    context.rotate(((index % 2 ? -2 : 2) * Math.PI) / 180);
    context.fillText(line, 0, 0);
    context.restore();
  });
}

function addNoise(testCase, context) {
  if (!testCase.noise) return;
  const random = seededRandom(90421);
  context.save();
  context.fillStyle = 'rgba(55,55,55,.10)';
  for (let index = 0; index < 900; index += 1) {
    const size = 1 + Math.floor(random() * 3);
    context.fillRect(random() * testCase.width, random() * testCase.height, size, size);
  }
  context.restore();
}

function rotate(source, degrees, background) {
  if (!degrees) return source;
  const sideways = Math.abs(degrees) % 180 === 90;
  const canvas = createCanvas(sideways ? source.height : source.width, sideways ? source.width : source.height);
  const context = canvas.getContext('2d');
  context.fillStyle = background;
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.translate(canvas.width / 2, canvas.height / 2);
  context.rotate((degrees * Math.PI) / 180);
  context.drawImage(source, -source.width / 2, -source.height / 2);
  return canvas;
}

for (const testCase of corpus.cases) {
  const { canvas, context } = prepareCanvas(testCase);
  if (testCase.layout === 'table') drawTable(testCase, context);
  else if (testCase.layout === 'handwriting') drawHandwriting(testCase, context);
  else drawLines(testCase, context);
  addNoise(testCase, context);
  const output = rotate(canvas, testCase.rotation || 0, testCase.background);
  const png = output.toBuffer('image/png');
  await writeFile(path.join(root, 'evaluation', testCase.fixture), png);
  if (testCase.id === 'clean-client') {
    await writeFile(path.join(root, 'demo', 'fixtures', 'sample-client-scan.png'), png);
    const pdf = new PDFDocument({ title: 'Fictional scanned client intake', rasterDPI: 144 });
    const pdfContext = pdf.beginPage(output.width, output.height);
    pdfContext.drawImage(output, 0, 0, output.width, output.height);
    pdf.endPage();
    await writeFile(path.join(root, 'demo', 'fixtures', 'sample-client-scan.pdf'), pdf.close());
  }
}

console.log(`Generated ${corpus.cases.length} fictional OCR fixtures in ${fixtureDirectory}.`);
