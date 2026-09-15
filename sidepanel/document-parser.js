(function installDocumentParser(root) {
  'use strict';

  const engine = root.NavaFormEngine;
  const MAX_FILE_BYTES = 15 * 1024 * 1024;
  const MAX_PDF_PAGES = 60;
  const MAX_TEXT_CHARS = 750000;
  const MIN_OCR_FIELD_CONFIDENCE = 70;
  const STRONG_OCR_FIELD_CONFIDENCE = 88;
  const SENSITIVE_KEYS = new Set(['ssn', 'ein']);
  const NAME_KEYS = new Set(['firstName', 'middleName', 'lastName', 'fullName']);

  const LABEL_RULES = [
    [/^(first|given) name$|^(primer nombre|nombre)$/, 'firstName'],
    [/^(middle|additional) name$|^(segundo nombre)$/, 'middleName'],
    [/^(last|family) name$|^surname$|^apellido$/, 'lastName'],
    [/^(applicant|client|customer|owner|contact|full|legal) name$|^name$|^nombre completo$/, 'fullName'],
    [/^(date of birth|birth date|dob|fecha de nacimiento)$/, 'dateOfBirth'],
    [/^(social security number|social security|ssn)$/, 'ssn'],
    [/^(email|email address|e mail|correo electronico)$/, 'email'],
    [/^(phone|phone number|telephone|mobile|mobile phone|cell phone|telefono)$/, 'phone'],
    [/^(street address|home address|residential address|address|address line 1|direccion)$/, 'addressLine1'],
    [/^(address line 2|apartment|apt|unit|suite)$/, 'addressLine2'],
    [/^(city|ciudad)$/, 'city'],
    [/^(state|province|estado)$/, 'state'],
    [/^county$/, 'county'],
    [/^(zip|zip code|postal code|codigo postal)$/, 'postalCode'],
    [/^country$/, 'country'],
    [/^(gender|sex)$/, 'gender'],
    [/^(ethnicity|race ethnicity|race and ethnicity)$/, 'ethnicity'],
    [/^(primary language|preferred language|language|idioma principal|idioma preferido|idioma)$/, 'primaryLanguage'],
    [/^marital status$/, 'maritalStatus'],
    [/^(immigration status|citizenship status)$/, 'immigrationStatus'],
    [/^(housing status|homelessness status)$/, 'housingStatus'],
    [/^household size$/, 'householdSize'],
    [/^(monthly household income|monthly income|gross monthly income|annual income)$/, 'income'],
    [/^(business legal name|legal business name|business name|company name|legal entity name)$/, 'businessName'],
    [/^(doing business as|dba|trade name|fictitious business name)$/, 'dba'],
    [/^(employer identification number|federal employer identification number|federal tax id|business tax id|ein)$/, 'ein'],
    [/^(business type|entity type|legal structure)$/, 'businessType'],
    [/^(business address|company address|business street address|business address line 1)$/, 'businessAddressLine1'],
    [/^(business address line 2|business suite|business unit)$/, 'businessAddressLine2'],
    [/^business city$/, 'businessCity'],
    [/^business state$/, 'businessState'],
    [/^(business zip|business zip code|business postal code)$/, 'businessPostalCode'],
    [/^(business phone|company phone)$/, 'businessPhone'],
    [/^(business email|company email)$/, 'businessEmail'],
    [/^(formation date|date of formation|incorporation date)$/, 'incorporationDate'],
    [/^(state of formation|state of incorporation|formation state)$/, 'stateOfFormation'],
  ];

  function clean(value) {
    return String(value ?? '')
      .replace(/\u0000/g, '')
      .replace(/[\t ]+/g, ' ')
      .replace(/^\s*[-–—:|]+\s*|\s*[-–—:|]+\s*$/g, '')
      .trim();
  }

  function mask(value, key) {
    if (!SENSITIVE_KEYS.has(key)) return String(value);
    const digits = String(value).replace(/\D/g, '');
    return digits.length >= 4 ? `••••${digits.slice(-4)}` : '••••';
  }

  function safeEvidence(value, key) {
    const snippet = clean(value).slice(0, 140);
    return SENSITIVE_KEYS.has(key) ? snippet.replace(/[\dXx*•-]{4,}/g, mask(snippet, key)) : snippet;
  }

  function keyForLabel(label) {
    const variants = String(label || '').split(/\s*(?:\/|\|)\s*/).map((value) => engine.normalize(value)).filter(Boolean);
    for (const variant of variants) {
      const match = LABEL_RULES.find(([pattern]) => pattern.test(variant));
      if (match) return match[1];
    }
    return null;
  }

  function validValue(key, value) {
    const text = clean(value);
    if (!text || text.length > 240) return false;
    if (key === 'email' || key === 'businessEmail') return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text);
    if (key === 'ssn') return /^\d{3}[- ]?\d{2}[- ]?\d{4}$/.test(text);
    if (key === 'ein') return /^\d{2}[- ]?\d{7}$/.test(text);
    if (['postalCode', 'businessPostalCode'].includes(key)) return /^\d{5}(?:-\d{4})?$/.test(text);
    if (['dateOfBirth', 'incorporationDate'].includes(key)) return /\d/.test(text) && text.length <= 32;
    return true;
  }

  function splitPersonName(value) {
    const parts = clean(value).split(/\s+/).filter(Boolean);
    if (parts.length < 2 || parts.length > 5) return {};
    return {
      firstName: parts[0],
      middleName: parts.length > 2 ? parts.slice(1, -1).join(' ') : undefined,
      lastName: parts.at(-1),
    };
  }

  function extractFieldsFromText(rawText) {
    const text = String(rawText || '').slice(0, MAX_TEXT_CHARS).replace(/\r/g, '');
    const lines = text.split('\n').map(clean).filter(Boolean);
    const fields = new Map();

    function add(key, value, confidence, evidence) {
      const cleaned = clean(value);
      if (!key || !validValue(key, cleaned)) return;
      const current = fields.get(key);
      const rank = { low: 1, medium: 2, high: 3 };
      if (current && rank[current.confidence] >= rank[confidence]) return;
      fields.set(key, {
        key,
        label: engine.LABELS[key] || key,
        value: cleaned,
        displayValue: mask(cleaned, key),
        confidence,
        evidence: safeEvidence(evidence || cleaned, key),
        sensitive: SENSITIVE_KEYS.has(key),
      });
    }

    lines.forEach((line, index) => {
      const pair = line.match(/^(.{2,64}?)(?:\s*[:#]\s*|\s{2,})(.{1,240})$/);
      if (pair) {
        const key = keyForLabel(pair[1]);
        if (key) add(key, pair[2], 'high', line);
      }

      const standaloneKey = keyForLabel(line.replace(/[?:]$/, ''));
      if (standaloneKey && lines[index + 1] && !keyForLabel(lines[index + 1])) {
        add(standaloneKey, lines[index + 1], 'medium', `${line}: ${lines[index + 1]}`);
      }
    });

    const emailMatches = [...text.matchAll(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi)];
    if (emailMatches[0] && !fields.has('businessEmail')) add('email', emailMatches[0][0], 'medium', emailMatches[0][0]);

    for (const line of lines) {
      if (!/fax/i.test(line)) {
        const phone = line.match(/(?:phone|telephone|mobile|cell)?\s*[:#-]?\s*(\+?1?[\s.-]?(?:\(\d{3}\)|\d{3})[\s.-]?\d{3}[\s.-]?\d{4})\b/i);
        if (phone) {
          add(/business|company/i.test(line) ? 'businessPhone' : 'phone', phone[1], /phone|telephone|mobile|cell/i.test(line) ? 'high' : 'medium', line);
          break;
        }
      }
    }

    const labeledSsn = text.match(/(?:social security(?: number)?|\bssn\b)\s*[:#-]?\s*(\d{3}[- ]?\d{2}[- ]?\d{4})/i);
    if (labeledSsn) add('ssn', labeledSsn[1], 'high', labeledSsn[0]);
    const labeledEin = text.match(/(?:employer identification(?: number)?|federal (?:employer )?(?:tax )?id|\bein\b)\s*[:#-]?\s*(\d{2}[- ]?\d{7})/i);
    if (labeledEin) add('ein', labeledEin[1], 'high', labeledEin[0]);

    const cityStateZip = lines.map((line) => ({ line, match: line.match(/^([A-Za-z .'-]{2,60}),?\s+([A-Z]{2})\s+(\d{5}(?:-\d{4})?)$/) })).find((item) => item.match);
    if (cityStateZip) {
      const business = fields.has('businessName') && !fields.has('fullName');
      add(business ? 'businessCity' : 'city', cityStateZip.match[1], 'medium', cityStateZip.line);
      add(business ? 'businessState' : 'state', cityStateZip.match[2], 'medium', cityStateZip.line);
      add(business ? 'businessPostalCode' : 'postalCode', cityStateZip.match[3], 'medium', cityStateZip.line);
    }

    const streetLine = lines.find((line) => /^\d{1,8}\s+[A-Za-z0-9 .'-]+\s(?:street|st|avenue|ave|road|rd|boulevard|blvd|lane|ln|drive|dr|court|ct|way|parkway|pkwy)\b/i.test(line));
    if (streetLine) {
      add(fields.has('businessName') && !fields.has('fullName') ? 'businessAddressLine1' : 'addressLine1', streetLine, 'medium', streetLine);
    }

    if (fields.has('fullName')) {
      const parts = splitPersonName(fields.get('fullName').value);
      if (parts.firstName) add('firstName', parts.firstName, 'medium', `Split from labeled name: ${fields.get('fullName').value}`);
      if (parts.middleName) add('middleName', parts.middleName, 'medium', `Split from labeled name: ${fields.get('fullName').value}`);
      if (parts.lastName) add('lastName', parts.lastName, 'medium', `Split from labeled name: ${fields.get('fullName').value}`);
    }

    return [...fields.values()];
  }

  function findOcrLine(field, page) {
    const value = engine.normalize(field.value);
    const label = engine.normalize(field.label);
    return (page.lines || []).map((line) => {
      const text = engine.normalize(line.text);
      let score = 0;
      if (value && text.includes(value)) score += 4;
      if (label && text.includes(label)) score += 2;
      return { line, score };
    }).filter((candidate) => candidate.score > 0)
      .sort((left, right) => right.score - left.score || (Number(right.line.confidence) || 0) - (Number(left.line.confidence) || 0))[0]?.line || null;
  }

  function extractFieldsFromOcrPages(pages) {
    const selected = new Map();
    let withheld = 0;
    (pages || []).forEach((page) => {
      extractFieldsFromText(page.text).forEach((field) => {
        const line = findOcrLine(field, page);
        const confidence = Math.max(0, Math.min(100, Number(line?.confidence ?? page.confidence) || 0));
        const requiredConfidence = ['email', 'businessEmail'].includes(field.key) ? 94
          : SENSITIVE_KEYS.has(field.key) ? 90
            : MIN_OCR_FIELD_CONFIDENCE;
        const suspiciousNameGlyph = NAME_KEYS.has(field.key) && /[|{}[\]~]/.test(line?.text || '');
        if (confidence < requiredConfidence || suspiciousNameGlyph) {
          withheld += 1;
          return;
        }
        const proposal = {
          ...field,
          confidence: confidence >= STRONG_OCR_FIELD_CONFIDENCE && field.confidence === 'high' ? 'medium' : 'low',
          evidence: `Page ${page.pageNumber} · OCR ${Math.round(confidence)}% · ${field.evidence}`,
          ocrConfidence: Math.round(confidence),
          reviewRequired: true,
          source: {
            method: 'ocr',
            pageNumber: page.pageNumber,
            region: line?.bbox || null,
            canvas: { width: page.width, height: page.height, rotation: page.rotation || 0 },
          },
        };
        const current = selected.get(field.key);
        if (!current || proposal.ocrConfidence > current.ocrConfidence) selected.set(field.key, proposal);
      });
    });
    return { fields: [...selected.values()], withheld };
  }

  function mergeFields(primary, secondary) {
    const rank = { low: 1, medium: 2, high: 3 };
    const merged = new Map(primary.map((field) => [field.key, field]));
    secondary.forEach((field) => {
      const current = merged.get(field.key);
      if (!current || rank[field.confidence] > rank[current.confidence]
        || (rank[field.confidence] === rank[current.confidence] && (field.ocrConfidence || 0) > (current.ocrConfidence || 0))) {
        merged.set(field.key, field);
      }
    });
    return [...merged.values()];
  }

  function extractFieldsFromObject(object) {
    const canonical = engine.canonicalizeParticipant(object || {});
    const derivedKeys = new Set(['fullName', 'mailingDifferent']);
    return Object.entries(canonical.values)
      .filter(([key, value]) => value !== undefined && value !== null && value !== '' && !derivedKeys.has(key))
      .map(([key, value]) => ({
        key,
        label: engine.LABELS[key] || key,
        value: String(value),
        displayValue: mask(value, key),
        confidence: 'high',
        evidence: `Labeled JSON field for ${engine.LABELS[key] || key}`,
        sensitive: SENSITIVE_KEYS.has(key),
      }));
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
        row.push(clean(value));
        value = '';
      } else if ((character === '\n' || character === '\r') && !quoted) {
        if (character === '\r' && text[index + 1] === '\n') index += 1;
        row.push(clean(value));
        if (row.some(Boolean)) rows.push(row);
        row = [];
        value = '';
      } else {
        value += character;
      }
    }
    row.push(clean(value));
    if (row.some(Boolean)) rows.push(row);
    return rows;
  }

  function delimitedToLabeledText(text, delimiter) {
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

  async function extractPdfText(arrayBuffer, onProgress) {
    const pdfjs = await import(assetUrl('../vendor/pdf.min.mjs'));
    pdfjs.GlobalWorkerOptions.workerSrc = assetUrl('../vendor/pdf.worker.min.mjs');
    const task = pdfjs.getDocument({
      data: new Uint8Array(arrayBuffer),
      isEvalSupported: false,
      useWorkerFetch: false,
    });
    try {
      const pdf = await task.promise;
      const pageCount = Math.min(pdf.numPages, MAX_PDF_PAGES);
      const pages = [];
      const ocrSources = [];
      for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
        const page = await pdf.getPage(pageNumber);
        const content = await page.getTextContent();
        let pageText = '';
        content.items.forEach((item) => {
          pageText += item.str || '';
          pageText += item.hasEOL ? '\n' : ' ';
        });
        const cleaned = pageText.trim();
        pages.push(cleaned);
        if (cleaned.replace(/\s/g, '').length < 24) {
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

  async function parseDocument(file, { onProgress = () => {} } = {}) {
    if (!file) throw new Error('Choose a document first.');
    if (file.size > MAX_FILE_BYTES) throw new Error('Choose a document smaller than 15 MB.');
    const extension = file.name.split('.').pop().toLowerCase();
    const warnings = [];
    let fields = [];
    let textLength = 0;
    let extractionMethod = 'structured';
    let ocrMetrics = null;

    if (extension === 'json' || file.type === 'application/json') {
      let object;
      try {
        object = JSON.parse(await file.text());
      } catch {
        throw new Error('The JSON file is not valid. Check its commas and quotation marks.');
      }
      if (!object || Array.isArray(object) || typeof object !== 'object') throw new Error('The JSON file must contain one client or business record.');
      fields = extractFieldsFromObject(object);
    } else {
      let extracted;
      if (extension === 'pdf' || file.type === 'application/pdf') {
        if (!root.NavaOcrEngine) throw new Error('The bundled on-device OCR engine did not load.');
        extracted = await extractPdfText(await file.arrayBuffer(), onProgress);
        warnings.push(...extracted.warnings);
        extractionMethod = extracted.ocrPages.length ? (extracted.text.trim() ? 'mixed' : 'ocr') : 'embedded-text';
      } else if (extension === 'docx' || file.type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
        extracted = { text: await extractDocxText(await file.arrayBuffer()), warnings: [] };
        extractionMethod = 'docx';
      } else if (['txt', 'csv', 'tsv'].includes(extension) || file.type.startsWith('text/')) {
        const rawText = await file.text();
        const delimiter = extension === 'tsv' ? '\t' : extension === 'csv' ? ',' : null;
        extracted = { text: delimiter ? delimitedToLabeledText(rawText, delimiter) : rawText, warnings: [] };
        extractionMethod = delimiter ? 'delimited-text' : 'text';
      } else if (['png', 'jpg', 'jpeg', 'webp'].includes(extension) || ['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
        if (!root.NavaOcrEngine) throw new Error('The bundled on-device OCR engine did not load.');
        const ocr = await root.NavaOcrEngine.recognizeSources([{
          pageNumber: 1,
          render: () => root.NavaOcrEngine.imageFileSource(file),
        }], { onProgress });
        extracted = { text: '', ocrPages: ocr.pages, ocrMetrics: ocr.metrics, warnings: ocr.warnings };
        warnings.push(...ocr.warnings);
        extractionMethod = 'ocr';
      } else {
        throw new Error('Use a PDF, PNG, JPEG, WebP, DOCX, TXT, CSV, TSV, or JSON file. HEIC, password-protected files, and legacy Word files are not supported.');
      }
      const text = String(extracted.text || '').slice(0, MAX_TEXT_CHARS);
      textLength = text.length;
      fields = extractFieldsFromText(text);
      if (extracted.ocrPages?.length) {
        const ocrExtraction = extractFieldsFromOcrPages(extracted.ocrPages);
        fields = mergeFields(fields, ocrExtraction.fields);
        ocrMetrics = { ...(extracted.ocrMetrics || {}), fieldsWithheld: ocrExtraction.withheld };
        warnings.push(`On-device OCR reviewed ${extracted.ocrPages.length} ${extracted.ocrPages.length === 1 ? 'page' : 'pages'}. Verify every proposed value against the source document.`);
        if (ocrExtraction.withheld) warnings.push(`${ocrExtraction.withheld} low-confidence OCR ${ocrExtraction.withheld === 1 ? 'candidate was' : 'candidates were'} withheld.`);
      } else if (!text.trim()) {
        warnings.push('No readable text was found. The OCR engine could not recover usable text from this document.');
      }
    }

    if (!fields.length) warnings.push('No clearly labeled demographic, identity, contact, address, or business fields were found.');
    return {
      file: { name: file.name, type: file.type || extension, size: file.size },
      fields,
      warnings,
      textLength,
      quality: {
        method: extractionMethod,
        ocr: ocrMetrics,
      },
    };
  }

  const api = {
    extractFieldsFromObject,
    extractFieldsFromOcrPages,
    extractFieldsFromText,
    delimitedToLabeledText,
    mergeFields,
    parseDocument,
  };

  root.NavaDocumentParser = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
