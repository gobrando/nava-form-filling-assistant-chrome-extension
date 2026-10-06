// Document field extraction: label rules, text, OCR and JSON field extraction with masking and evidence, the OCR review policy, and parseDocument (validate, read, extract, assemble).
(function installDocumentParser(root) {
  'use strict';

  const engine = root.NavaFormEngine;
  const readers = root.NavaDocumentReaders;
  const clean = readers.cleanText;
  const MAX_FILE_BYTES = 15 * 1024 * 1024;
  const MAX_TEXT_CHARS = readers.MAX_TEXT_CHARS;
  const MIN_OCR_FIELD_CONFIDENCE = 70;
  const STRONG_OCR_FIELD_CONFIDENCE = 88;
  const SENSITIVE_KEYS = new Set(['ssn', 'ein']);
  const NAME_KEYS = new Set(['firstName', 'middleName', 'lastName', 'fullName']);
  const CONFIDENCE_RANK = { low: 1, medium: 2, high: 3 };

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

  /** Collects candidate fields, keeping one valid, masked value per key at its highest confidence. */
  function fieldCollector() {
    const fields = new Map();

    function add(key, value, confidence, evidence) {
      const cleaned = clean(value);
      if (!key || !validValue(key, cleaned)) return;
      const current = fields.get(key);
      if (current && CONFIDENCE_RANK[current.confidence] >= CONFIDENCE_RANK[confidence]) return;
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

    return { fields, add };
  }

  /** "Label: value" lines, and a label line followed by its value line. */
  function addLabeledLines(lines, add) {
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
  }

  /** The first phone number outside a fax line; business or company lines file it as the business phone. */
  function addFirstPhone(lines, add) {
    for (const line of lines) {
      if (!/fax/i.test(line)) {
        const phone = line.match(/(?:phone|telephone|mobile|cell)?\s*[:#-]?\s*(\+?1?[\s.-]?(?:\(\d{3}\)|\d{3})[\s.-]?\d{3}[\s.-]?\d{4})\b/i);
        if (phone) {
          add(/business|company/i.test(line) ? 'businessPhone' : 'phone', phone[1], /phone|telephone|mobile|cell/i.test(line) ? 'high' : 'medium', line);
          return;
        }
      }
    }
  }

  /** The first email and phone number in the text, and SSN or EIN digits only where their label precedes them. */
  function addContactAndIdentifiers(text, lines, fields, add) {
    const emailMatches = [...text.matchAll(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi)];
    if (emailMatches[0] && !fields.has('businessEmail')) add('email', emailMatches[0][0], 'medium', emailMatches[0][0]);

    addFirstPhone(lines, add);

    const labeledSsn = text.match(/(?:social security(?: number)?|\bssn\b)\s*[:#-]?\s*(\d{3}[- ]?\d{2}[- ]?\d{4})/i);
    if (labeledSsn) add('ssn', labeledSsn[1], 'high', labeledSsn[0]);
    const labeledEin = text.match(/(?:employer identification(?: number)?|federal (?:employer )?(?:tax )?id|\bein\b)\s*[:#-]?\s*(\d{2}[- ]?\d{7})/i);
    if (labeledEin) add('ein', labeledEin[1], 'high', labeledEin[0]);
  }

  /** A "City, ST 12345" line and a numbered street line, filed as business address fields for a business-only record. */
  function addAddressLines(lines, fields, add) {
    const business = fields.has('businessName') && !fields.has('fullName');
    const cityStateZip = lines.map((line) => ({ line, match: line.match(/^([A-Za-z .'-]{2,60}),?\s+([A-Z]{2})\s+(\d{5}(?:-\d{4})?)$/) })).find((item) => item.match);
    if (cityStateZip) {
      add(business ? 'businessCity' : 'city', cityStateZip.match[1], 'medium', cityStateZip.line);
      add(business ? 'businessState' : 'state', cityStateZip.match[2], 'medium', cityStateZip.line);
      add(business ? 'businessPostalCode' : 'postalCode', cityStateZip.match[3], 'medium', cityStateZip.line);
    }

    const streetLine = lines.find((line) => /^\d{1,8}\s+[A-Za-z0-9 .'-]+\s(?:street|st|avenue|ave|road|rd|boulevard|blvd|lane|ln|drive|dr|court|ct|way|parkway|pkwy)\b/i.test(line));
    if (streetLine) {
      add(business ? 'businessAddressLine1' : 'addressLine1', streetLine, 'medium', streetLine);
    }
  }

  /** First, middle and last name split from a labeled full name. */
  function addSplitName(fields, add) {
    if (!fields.has('fullName')) return;
    const fullName = fields.get('fullName').value;
    const parts = splitPersonName(fullName);
    const evidence = `Split from labeled name: ${fullName}`;
    if (parts.firstName) add('firstName', parts.firstName, 'medium', evidence);
    if (parts.middleName) add('middleName', parts.middleName, 'medium', evidence);
    if (parts.lastName) add('lastName', parts.lastName, 'medium', evidence);
  }

  function extractFieldsFromText(rawText) {
    const text = String(rawText || '').slice(0, MAX_TEXT_CHARS).replace(/\r/g, '');
    const lines = text.split('\n').map(clean).filter(Boolean);
    const { fields, add } = fieldCollector();
    addLabeledLines(lines, add);
    addContactAndIdentifiers(text, lines, fields, add);
    addAddressLines(lines, fields, add);
    addSplitName(fields, add);
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

  /** OCR confidence a field needs before it is proposed: stricter for email and sensitive identifiers. */
  function requiredOcrConfidence(key) {
    if (['email', 'businessEmail'].includes(key)) return 94;
    return SENSITIVE_KEYS.has(key) ? 90 : MIN_OCR_FIELD_CONFIDENCE;
  }

  /**
   * An OCR field proposal with page-region provenance, or null when it is withheld for low confidence or a
   * suspicious name glyph. OCR values never rank above medium and always start unchecked (reviewRequired).
   */
  function ocrProposal(field, page) {
    const line = findOcrLine(field, page);
    const confidence = Math.max(0, Math.min(100, Number(line?.confidence ?? page.confidence) || 0));
    const suspiciousNameGlyph = NAME_KEYS.has(field.key) && /[|{}[\]~]/.test(line?.text || '');
    if (confidence < requiredOcrConfidence(field.key) || suspiciousNameGlyph) return null;
    return {
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
  }

  function extractFieldsFromOcrPages(pages) {
    const selected = new Map();
    let withheld = 0;
    (pages || []).forEach((page) => {
      extractFieldsFromText(page.text).forEach((field) => {
        const proposal = ocrProposal(field, page);
        if (!proposal) {
          withheld += 1;
          return;
        }
        const current = selected.get(field.key);
        if (!current || proposal.ocrConfidence > current.ocrConfidence) selected.set(field.key, proposal);
      });
    });
    return { fields: [...selected.values()], withheld };
  }

  function mergeFields(primary, secondary) {
    const merged = new Map(primary.map((field) => [field.key, field]));
    secondary.forEach((field) => {
      const current = merged.get(field.key);
      if (!current || CONFIDENCE_RANK[field.confidence] > CONFIDENCE_RANK[current.confidence]
        || (CONFIDENCE_RANK[field.confidence] === CONFIDENCE_RANK[current.confidence] && (field.ocrConfidence || 0) > (current.ocrConfidence || 0))) {
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

  /** CSV/TSV rows as "Label: value" lines, matched with this parser's label rules. */
  function delimitedToLabeledText(text, delimiter) {
    return readers.delimitedToLabeledText(text, delimiter, keyForLabel);
  }

  /** Fields from the text a reader returned, merged with reviewed OCR proposals, and the extraction warnings. */
  function extractReadFields(read) {
    const warnings = [...read.warnings];
    let fields = extractFieldsFromText(read.text);
    let ocrMetrics = null;
    if (read.ocrPages.length) {
      const pageCount = read.ocrPages.length;
      const ocrExtraction = extractFieldsFromOcrPages(read.ocrPages);
      fields = mergeFields(fields, ocrExtraction.fields);
      ocrMetrics = { ...(read.ocrMetrics || {}), fieldsWithheld: ocrExtraction.withheld };
      warnings.push(`On-device OCR reviewed ${pageCount} ${pageCount === 1 ? 'page' : 'pages'}. Verify every proposed value against the source document.`);
      if (ocrExtraction.withheld) warnings.push(`${ocrExtraction.withheld} low-confidence OCR ${ocrExtraction.withheld === 1 ? 'candidate was' : 'candidates were'} withheld.`);
    } else if (!read.text.trim()) {
      warnings.push('No readable text was found. The OCR engine could not recover usable text from this document.');
    }
    return { fields, warnings, textLength: read.text.length, ocrMetrics };
  }

  function documentResult(file, read, extraction) {
    const warnings = [...extraction.warnings];
    if (!extraction.fields.length) warnings.push('No clearly labeled demographic, identity, contact, address, or business fields were found.');
    return {
      file: { name: file.name, type: file.type || read.extension, size: file.size },
      fields: extraction.fields,
      warnings,
      textLength: extraction.textLength,
      quality: {
        method: read.method,
        ocr: extraction.ocrMetrics,
      },
    };
  }

  /** Validates the file, reads it on this device, extracts reviewable fields, and assembles the review result. */
  async function parseDocument(file, { onProgress = () => {} } = {}) {
    if (!file) throw new Error('Choose a document first.');
    if (file.size > MAX_FILE_BYTES) throw new Error('Choose a document smaller than 15 MB.');
    const read = await readers.readDocument(file, { onProgress, keyForLabel });
    const extraction = read.record
      ? { fields: extractFieldsFromObject(read.record), warnings: [], textLength: 0, ocrMetrics: null }
      : extractReadFields(read);
    return documentResult(file, read, extraction);
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
