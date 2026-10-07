const test = require('node:test');
const assert = require('node:assert/strict');

const readers = require('../sidepanel/document-readers.js');

const UNSUPPORTED = 'Use a PDF, PNG, JPEG, WebP, DOCX, TXT, CSV, TSV, or JSON file. HEIC, password-protected files, and legacy Word files are not supported.';

/** A File-shaped fake: the readers only use name, type, text() and arrayBuffer(). */
function fakeFile(name, type, content = '') {
  return {
    name,
    type,
    size: content.length,
    text: async () => content,
    arrayBuffer: async () => new TextEncoder().encode(content).buffer,
  };
}

function withOcrEngine(engine, action) {
  const previous = globalThis.NavaOcrEngine;
  if (engine) globalThis.NavaOcrEngine = engine;
  else delete globalThis.NavaOcrEngine;
  return Promise.resolve().then(action).finally(() => {
    if (previous === undefined) delete globalThis.NavaOcrEngine;
    else globalThis.NavaOcrEngine = previous;
  });
}

const labelKeys = { 'first name': 'firstName', 'last name': 'lastName', email: 'email' };
const keyForLabel = (label) => labelKeys[String(label).toLowerCase()] || null;

test('the format table matches by extension or MIME type, in order', () => {
  const kind = (extension, type) => readers.formatFor(extension, type)?.kind ?? null;
  assert.equal(kind('pdf', ''), 'pdf');
  assert.equal(kind('bin', 'application/pdf'), 'pdf');
  assert.equal(kind('json', ''), 'json');
  assert.equal(kind('csv', 'application/json'), 'json', 'JSON is checked before text');
  assert.equal(kind('docx', ''), 'docx');
  assert.equal(kind('bin', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'), 'docx');
  assert.equal(kind('tsv', ''), 'text');
  assert.equal(kind('log', 'text/plain'), 'text');
  assert.equal(kind('jpeg', ''), 'image');
  assert.equal(kind('bin', 'image/webp'), 'image');
  assert.equal(kind('heic', 'image/heic'), null);
  assert.equal(kind('doc', 'application/msword'), null);
  assert.deepEqual(readers.FORMATS.map((format) => format.kind), ['json', 'pdf', 'docx', 'text', 'image']);
});

test('unsupported files are refused with the supported-format message', async () => {
  await assert.rejects(readers.readDocument(fakeFile('photo.heic', 'image/heic')), { message: UNSUPPORTED });
  await assert.rejects(readers.readDocument(fakeFile('letter.doc', 'application/msword')), { message: UNSUPPORTED });
});

test('CSV rows keep quoted delimiters, escaped quotes, and CRLF line ends, and skip blank rows', () => {
  assert.deepEqual(
    readers.parseDelimitedRows('Name,Note\r\n"Santos, LLC","She said ""hi"""\r\n\r\n , \nlast,row', ','),
    [['Name', 'Note'], ['Santos, LLC', 'She said "hi"'], ['last', 'row']],
  );
  assert.deepEqual(readers.parseDelimitedRows('a\tb\n"c\td"\te', '\t'), [['a', 'b'], ['c d', 'e']], 'cells are cleaned like extracted text');
  assert.deepEqual(readers.parseDelimitedRows('"multi\nline",x', ','), [['multi\nline', 'x']]);
  assert.equal(readers.cleanText('  :  Maria\t\tSantos  | '), 'Maria Santos');
});

test('delimited rows become labeled lines with the injected label matcher', () => {
  assert.equal(
    readers.delimitedToLabeledText('First Name,Last Name,Email\nMaria,Santos,maria@example.org', ',', keyForLabel),
    'First Name: Maria\nLast Name: Santos\nEmail: maria@example.org',
  );
  assert.equal(
    readers.delimitedToLabeledText('First Name,Maria\nLast Name,Santos\nUnknown,Value\nEmail,maria@example.org,alt@example.org', ',', keyForLabel),
    'First Name: Maria\nLast Name: Santos\nEmail: maria@example.org, alt@example.org',
  );
  assert.equal(readers.delimitedToLabeledText('First Name\tMaria\tElena', '\t', keyForLabel), 'First Name: Maria Elena');
  assert.equal(readers.delimitedToLabeledText('', ',', keyForLabel), '');
  assert.equal(readers.delimitedToLabeledText('First Name,Last Name', ',', () => null), '');
});

test('text, CSV, and JSON files are read without OCR, and text is capped', async () => {
  const csv = await readers.readDocument(fakeFile('client.CSV', 'text/csv', 'First Name,Email\nMaria,maria@example.org'), { keyForLabel });
  assert.deepEqual(csv, {
    extension: 'csv',
    method: 'delimited-text',
    text: 'First Name: Maria\nEmail: maria@example.org',
    ocrPages: [],
    ocrMetrics: null,
    warnings: [],
  });

  const plain = await readers.readDocument(fakeFile('notes.txt', 'text/plain', 'x'.repeat(readers.MAX_TEXT_CHARS + 10)));
  assert.equal(plain.method, 'text');
  assert.equal(plain.text.length, readers.MAX_TEXT_CHARS);

  const json = await readers.readDocument(fakeFile('client.json', 'application/json', '{"first_name":"Maria"}'));
  assert.deepEqual(json, { extension: 'json', method: 'structured', record: { first_name: 'Maria' } });
  await assert.rejects(readers.readDocument(fakeFile('client.json', '', '{nope')), /The JSON file is not valid\. Check its commas and quotation marks\./);
  await assert.rejects(readers.readDocument(fakeFile('client.json', '', '[{}]')), /must contain one client or business record/);
});

test('PDF and image reading require the bundled OCR engine, and DOCX requires the bundled unzipper', async () => {
  await withOcrEngine(null, async () => {
    await assert.rejects(readers.readDocument(fakeFile('scan.pdf', 'application/pdf')), /The bundled on-device OCR engine did not load\./);
    await assert.rejects(readers.readDocument(fakeFile('scan.png', 'image/png')), /The bundled on-device OCR engine did not load\./);
  });
  await assert.rejects(readers.readDocument(fakeFile('form.docx', '')), /The local DOCX parser did not load\./);
});

test('images are read through on-device OCR', async () => {
  const sources = [];
  const engine = {
    imageFileSource: (file) => ({ image: file.name }),
    async recognizeSources(list, options) {
      sources.push(...list.map((source) => ({ pageNumber: source.pageNumber, rendered: source.render() })));
      options.onProgress({ status: 'reading' });
      return { pages: [{ pageNumber: 1, text: 'First Name: Maria' }], warnings: ['Rotated 90°.'], metrics: { pages: 1 } };
    },
  };
  const progress = [];
  const image = await withOcrEngine(engine, () => readers.readDocument(fakeFile('scan.JPG', ''), { onProgress: (update) => progress.push(update) }));
  assert.deepEqual(sources, [{ pageNumber: 1, rendered: { image: 'scan.JPG' } }]);
  assert.deepEqual(progress, [{ status: 'reading' }]);
  assert.deepEqual(image, {
    extension: 'jpg',
    method: 'ocr',
    text: '',
    ocrPages: [{ pageNumber: 1, text: 'First Name: Maria' }],
    ocrMetrics: { pages: 1 },
    warnings: ['Rotated 90°.'],
  });
});

/** A pdf.js-shaped document whose pages hold the given embedded text. */
function fakePdf(pageTexts) {
  return {
    numPages: pageTexts.length,
    async getPage(pageNumber) {
      return {
        pageNumber,
        async getTextContent() {
          return { items: [{ str: pageTexts[pageNumber - 1], hasEOL: true }, { str: 'end' }] };
        },
      };
    },
  };
}

test('PDF reading stops at the page cap with a warning and OCRs only pages without embedded text', async () => {
  const longText = 'Embedded text with plenty of characters on this page.';
  const capped = await withOcrEngine(null, () => readers.readPdfDocument(fakePdf(Array(readers.MAX_PDF_PAGES + 1).fill(longText))));
  assert.equal(readers.MAX_PDF_PAGES, 60);
  assert.deepEqual(capped.warnings, ['Only the first 60 PDF pages were read.']);
  assert.equal(capped.text.split('\n\n').length, 60);
  assert.equal(capped.text.split('\n\n')[0], `${longText}\nend`);
  assert.deepEqual(capped.ocrPages, []);
  assert.equal(capped.ocrMetrics, null);

  const recognized = [];
  const engine = {
    pdfPageSource: (pdfPage) => ({ canvasFor: pdfPage.pageNumber }),
    async recognizeSources(sources) {
      for (const source of sources) recognized.push({ pageNumber: source.pageNumber, rendered: await source.render() });
      return { pages: [{ pageNumber: 2, text: 'SSN: 123-45-6789' }], warnings: ['OCR warning'], metrics: { pages: 1 } };
    },
  };
  const mixed = await withOcrEngine(engine, () => readers.readPdfDocument(fakePdf([longText, ' ', longText])));
  assert.deepEqual(recognized, [{ pageNumber: 2, rendered: { canvasFor: 2 } }]);
  assert.deepEqual(mixed.ocrPages, [{ pageNumber: 2, text: 'SSN: 123-45-6789' }]);
  assert.deepEqual(mixed.warnings, ['OCR warning']);
});
