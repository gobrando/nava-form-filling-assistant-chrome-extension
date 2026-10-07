// Document readers: turn a chosen File into text, labeled CSV/TSV rows, OCR pages, or a JSON record on this device, with bundled pdf.js, fflate and the on-device OCR engine only.
(function installDocumentReaders(root) {
  'use strict';

  const MAX_PDF_PAGES = 60;
  const MAX_TEXT_CHARS = 750000;
  const MIN_EMBEDDED_PAGE_CHARACTERS = 24;
  const DOCX_MIME_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  const UNSUPPORTED_FORMAT_MESSAGE = 'Use a PDF, PNG, JPEG, WebP, DOCX, TXT, CSV, TSV, or JSON file. HEIC, password-protected files, and legacy Word files are not supported.';

  /** Whitespace and edge-separator cleanup shared by row cells and extracted field values. */
  function cleanText(value) {
    return String(value ?? '')
      .replace(/\u0000/g, '')
      .replace(/[\t ]+/g, ' ')
      .replace(/^\s*[-–—:|]+\s*|\s*[-–—:|]+\s*$/g, '')
      .trim();
  }

  function fileExtension(file) {
    return file.name.split('.').pop().toLowerCase();
  }

  function parseDelimitedRows(text, delimiter) {
    const rows = [];
    let row = [];
    let value = '';
    let quoted = false;
    for (let index = 0; index < text.length; index += 1) {
      const character = text[index];
      if (character === '"') {
        if (quoted && text[index + 1] === '"') {
          value += '"';
          index += 1;
        } else {
          quoted = !quoted;
        }
      } else if (character === delimiter && !quoted) {
        row.push(cleanText(value));
        value = '';
      } else if ((character === '\n' || character === '\r') && !quoted) {
        if (character === '\r' && text[index + 1] === '\n') index += 1;
        row.push(cleanText(value));
        if (row.some(Boolean)) rows.push(row);
        row = [];
        value = '';
      } else {
        value += character;
      }
    }
    row.push(cleanText(value));
    if (row.some(Boolean)) rows.push(row);
    return rows;
  }

  /**
   * Turns CSV/TSV rows into "Label: value" lines: a header row over one value row, or label/value rows.
   * `keyForLabel(label)` is the field-label matcher; it returns a field key or null.
   */
  function delimitedToLabeledText(text, delimiter, keyForLabel) {
    const rows = parseDelimitedRows(String(text || ''), delimiter);
    if (!rows.length) return '';
    const header = rows[0];
    const knownHeaders = header.filter((label) => keyForLabel(label)).length;
    const secondRowHasLabels = rows[1]?.some((label) => keyForLabel(label));
    if (rows.length > 1 && knownHeaders >= Math.ceil(header.length / 2) && !secondRowHasLabels && header.length === rows[1].length) {
      return header.map((label, index) => `${label}: ${rows[1][index] || ''}`).join('\n');
    }
    return rows
      .filter((row) => row.length >= 2 && keyForLabel(row[0]))
      .map((row) => `${row[0]}: ${row.slice(1).join(delimiter === '\t' ? ' ' : ', ')}`)
      .join('\n');
  }

  function assetUrl(relativePath) {
    if (root.chrome?.runtime?.id) return root.chrome.runtime.getURL(relativePath.replace(/^\.\.\//, ''));
    return new URL(relativePath, location.href).href;
  }

  function requireOcrEngine() {
    if (!root.NavaOcrEngine) throw new Error('The bundled on-device OCR engine did not load.');
  }

  async function pdfPageText(pdf, pageNumber) {
    const page = await pdf.getPage(pageNumber);
    const content = await page.getTextContent();
    let pageText = '';
    content.items.forEach((item) => {
      pageText += item.str || '';
      pageText += item.hasEOL ? '\n' : ' ';
    });
    return pageText.trim();
  }

  /**
   * Reads a loaded pdf.js document: embedded text from the first MAX_PDF_PAGES pages, and OCR for pages
   * with almost no embedded text. Warns when pages past the cap were skipped.
   */
  async function readPdfDocument(pdf, onProgress) {
    const pageCount = Math.min(pdf.numPages, MAX_PDF_PAGES);
    const pages = [];
    const ocrSources = [];
    for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
      const cleaned = await pdfPageText(pdf, pageNumber);
      pages.push(cleaned);
      if (cleaned.replace(/\s/g, '').length < MIN_EMBEDDED_PAGE_CHARACTERS) {
        ocrSources.push({
          pageNumber,
          render: async () => root.NavaOcrEngine.pdfPageSource(await pdf.getPage(pageNumber)),
        });
      }
    }
    const ocr = ocrSources.length
      ? await root.NavaOcrEngine.recognizeSources(ocrSources, { onProgress })
      : { pages: [], warnings: [], metrics: null };
    return {
      text: pages.join('\n\n'),
      ocrPages: ocr.pages,
      ocrMetrics: ocr.metrics,
      warnings: [
        ...(pdf.numPages > MAX_PDF_PAGES ? [`Only the first ${MAX_PDF_PAGES} PDF pages were read.`] : []),
        ...ocr.warnings,
      ],
    };
  }

  async function extractPdfText(arrayBuffer, onProgress) {
    const pdfjs = await import(assetUrl('../vendor/pdf.min.mjs'));
    pdfjs.GlobalWorkerOptions.workerSrc = assetUrl('../vendor/pdf.worker.min.mjs');
    const task = pdfjs.getDocument({
      data: new Uint8Array(arrayBuffer),
      isEvalSupported: false,
      useWorkerFetch: false,
    });
    try {
      return await readPdfDocument(await task.promise, onProgress);
    } finally {
      await task.destroy();
    }
  }

  function xmlText(xmlText) {
    const documentXml = new DOMParser().parseFromString(xmlText, 'application/xml');
    if (documentXml.querySelector('parsererror')) throw new Error('The Word document XML could not be read.');
    const paragraphs = [...documentXml.getElementsByTagNameNS('*', 'p')];
    return paragraphs.map((paragraph) =>
      [...paragraph.getElementsByTagNameNS('*', 't')].map((node) => node.textContent || '').join(''),
    ).filter(Boolean).join('\n');
  }

  async function extractDocxText(arrayBuffer) {
    if (!root.fflate?.unzipSync) throw new Error('The local DOCX parser did not load.');
    const archive = root.fflate.unzipSync(new Uint8Array(arrayBuffer));
    const names = Object.keys(archive).filter((name) =>
      name === 'word/document.xml' || /^word\/(header|footer)\d+\.xml$/.test(name),
    );
    if (!names.includes('word/document.xml')) throw new Error('This file does not contain a readable Word document.');
    const decoder = new TextDecoder('utf-8');
    return names.map((name) => xmlText(decoder.decode(archive[name]))).join('\n');
  }

  async function readJsonRecord(file) {
    let record;
    try {
      record = JSON.parse(await file.text());
    } catch {
      throw new Error('The JSON file is not valid. Check its commas and quotation marks.');
    }
    if (!record || Array.isArray(record) || typeof record !== 'object') throw new Error('The JSON file must contain one client or business record.');
    return { method: 'structured', record };
  }

  async function readPdf(file, { onProgress }) {
    requireOcrEngine();
    const extracted = await extractPdfText(await file.arrayBuffer(), onProgress);
    const method = extracted.ocrPages.length ? (extracted.text.trim() ? 'mixed' : 'ocr') : 'embedded-text';
    return { method, ...extracted };
  }

  async function readDocx(file) {
    return { method: 'docx', text: await extractDocxText(await file.arrayBuffer()), warnings: [] };
  }

  async function readText(file, { extension, keyForLabel }) {
    const rawText = await file.text();
    const delimiter = extension === 'tsv' ? '\t' : extension === 'csv' ? ',' : null;
    return {
      method: delimiter ? 'delimited-text' : 'text',
      text: delimiter ? delimitedToLabeledText(rawText, delimiter, keyForLabel) : rawText,
      warnings: [],
    };
  }

  async function readImage(file, { onProgress }) {
    requireOcrEngine();
    const ocr = await root.NavaOcrEngine.recognizeSources([{
      pageNumber: 1,
      render: () => root.NavaOcrEngine.imageFileSource(file),
    }], { onProgress });
    return { method: 'ocr', text: '', ocrPages: ocr.pages, ocrMetrics: ocr.metrics, warnings: ocr.warnings };
  }

  /** Supported formats in match order: a file matches by extension or MIME type, and the first match reads it. */
  const FORMATS = [
    { kind: 'json', extensions: ['json'], mimeTypes: ['application/json'], read: readJsonRecord },
    { kind: 'pdf', extensions: ['pdf'], mimeTypes: ['application/pdf'], read: readPdf },
    { kind: 'docx', extensions: ['docx'], mimeTypes: [DOCX_MIME_TYPE], read: readDocx },
    { kind: 'text', extensions: ['txt', 'csv', 'tsv'], mimeTypes: [], mimePrefix: 'text/', read: readText },
    { kind: 'image', extensions: ['png', 'jpg', 'jpeg', 'webp'], mimeTypes: ['image/png', 'image/jpeg', 'image/webp'], read: readImage },
  ];

  function formatFor(extension, mimeType) {
    return FORMATS.find((format) => format.extensions.includes(extension)
      || format.mimeTypes.includes(mimeType)
      || (format.mimePrefix && mimeType.startsWith(format.mimePrefix))) || null;
  }

  /**
   * Reads a file with the reader for its format. Returns `{ extension, method, text, ocrPages, ocrMetrics, warnings }`
   * with text capped at MAX_TEXT_CHARS, or `{ extension, method: 'structured', record }` for a JSON record.
   */
  async function readDocument(file, { onProgress = () => {}, keyForLabel = () => null } = {}) {
    const extension = fileExtension(file);
    const format = formatFor(extension, file.type);
    if (!format) throw new Error(UNSUPPORTED_FORMAT_MESSAGE);
    const read = await format.read(file, { extension, onProgress, keyForLabel });
    if (read.record) return { extension, ...read };
    return {
      extension,
      method: read.method,
      text: String(read.text || '').slice(0, MAX_TEXT_CHARS),
      ocrPages: read.ocrPages || [],
      ocrMetrics: read.ocrMetrics || null,
      warnings: read.warnings,
    };
  }

  const api = {
    MAX_PDF_PAGES,
    MAX_TEXT_CHARS,
    FORMATS,
    cleanText,
    fileExtension,
    formatFor,
    parseDelimitedRows,
    delimitedToLabeledText,
    readPdfDocument,
    readDocument,
  };

  root.NavaDocumentReaders = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
