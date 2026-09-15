const test = require('node:test');
const assert = require('node:assert/strict');

require('../shared/form-engine.js');
const ocr = require('../sidepanel/ocr-engine.js');
const parser = require('../sidepanel/document-parser.js');

function byKey(fields) {
  return Object.fromEntries(fields.map((field) => [field.key, field]));
}

test('extracts strongly labeled demographic and identity fields and masks SSN evidence', () => {
  const fields = byKey(parser.extractFieldsFromText(`
    Legal Name: Maria Elena Santos
    Date of Birth: 06/14/1988
    SSN: 123-45-6789
    Email: maria.santos@example.org
    Phone: (951) 555-0198
    Address: 125 Market Street
    Riverside, CA 92501
  `));

  assert.equal(fields.firstName.value, 'Maria');
  assert.equal(fields.middleName.value, 'Elena');
  assert.equal(fields.lastName.value, 'Santos');
  assert.equal(fields.dateOfBirth.value, '06/14/1988');
  assert.equal(fields.email.value, 'maria.santos@example.org');
  assert.equal(fields.addressLine1.value, '125 Market Street');
  assert.equal(fields.city.value, 'Riverside');
  assert.equal(fields.state.value, 'CA');
  assert.equal(fields.postalCode.value, '92501');
  assert.equal(fields.ssn.displayValue, '••••6789');
  assert.doesNotMatch(fields.ssn.evidence, /123-45-6789/);
});

test('extracts labeled business fields and masks EIN evidence', () => {
  const fields = byKey(parser.extractFieldsFromText(`
    Business Legal Name: Juniper Bicycle Works LLC
    DBA: Juniper Bikes
    EIN: 12-3456789
    Entity Type: Limited Liability Company
    Business Address: 4400 Mission Boulevard
    Business City: San Diego
    Business State: CA
    Business ZIP Code: 92109
    Business Email: hello@juniper.example
  `));

  assert.equal(fields.businessName.value, 'Juniper Bicycle Works LLC');
  assert.equal(fields.dba.value, 'Juniper Bikes');
  assert.equal(fields.ein.displayValue, '••••6789');
  assert.doesNotMatch(fields.ein.evidence, /12-3456789/);
  assert.equal(fields.businessAddressLine1.value, '4400 Mission Boulevard');
  assert.equal(fields.businessPostalCode.value, '92109');
  assert.equal(fields.email, undefined);
});

test('reads CSV header/value rows, including quoted commas', () => {
  const labeled = parser.delimitedToLabeledText(
    'First Name,Last Name,Email,Business Legal Name\nMaria,Santos,maria@example.org,"Santos, LLC"',
    ',',
  );
  const fields = byKey(parser.extractFieldsFromText(labeled));

  assert.equal(fields.firstName.value, 'Maria');
  assert.equal(fields.lastName.value, 'Santos');
  assert.equal(fields.email.value, 'maria@example.org');
  assert.equal(fields.businessName.value, 'Santos, LLC');
});

test('reads two-column CSV label/value rows', () => {
  const labeled = parser.delimitedToLabeledText(
    'First Name,Maria\nLast Name,Santos\nEmail,maria@example.org',
    ',',
  );
  const fields = byKey(parser.extractFieldsFromText(labeled));

  assert.equal(fields.firstName.value, 'Maria');
  assert.equal(fields.lastName.value, 'Santos');
  assert.equal(fields.email.value, 'maria@example.org');
});

test('does not treat an unlabeled nine-digit number as an SSN or EIN', () => {
  const fields = byKey(parser.extractFieldsFromText('Reference number: 123456789\nCase status: open'));
  assert.equal(fields.ssn, undefined);
  assert.equal(fields.ein, undefined);
});

test('canonicalizes nested JSON business data', () => {
  const fields = byKey(parser.extractFieldsFromObject({
    business: {
      legalName: 'Acme Services LLC',
      ein: '98-7654321',
      type: 'LLC',
      address: { street: '10 Oak Road', city: 'Austin', state: 'Texas', zip: '78701' },
    },
  }));

  assert.equal(fields.businessName.value, 'Acme Services LLC');
  assert.equal(fields.ein.displayValue, '••••4321');
  assert.equal(fields.businessAddressLine1.value, '10 Oak Road');
  assert.equal(fields.businessState.value, 'Texas');
});

test('caps OCR image dimensions without changing aspect ratio', () => {
  const dimensions = ocr.boundedDimensions(6000, 4000, 8_000_000);
  assert.ok(dimensions.pixels <= 8_000_000);
  assert.ok(Math.abs(dimensions.width / dimensions.height - 1.5) < 0.01);
});

test('extracts OCR line geometry from Tesseract blocks', () => {
  const lines = ocr.linesFromResult({
    blocks: [{ paragraphs: [{ lines: [{ text: 'First Name: Maria', confidence: 94, bbox: { x0: 10, y0: 20, x1: 210, y1: 48 } }] }] }],
  });
  assert.deepEqual(lines[0], {
    text: 'First Name: Maria',
    confidence: 94,
    bbox: { x0: 10, y0: 20, x1: 210, y1: 48 },
  });
});

test('adds OCR confidence and page-region provenance while masking sensitive evidence', () => {
  const result = parser.extractFieldsFromOcrPages([{
    pageNumber: 2,
    text: 'First Name: Maria\nSSN: 123-45-6789',
    confidence: 93,
    width: 1200,
    height: 1600,
    rotation: 90,
    lines: [
      { text: 'First Name: Maria', confidence: 96, bbox: { x0: 20, y0: 30, x1: 310, y1: 70 } },
      { text: 'SSN: 123-45-6789', confidence: 91, bbox: { x0: 20, y0: 90, x1: 330, y1: 130 } },
    ],
  }]);
  const fields = byKey(result.fields);

  assert.equal(fields.firstName.confidence, 'medium');
  assert.equal(fields.firstName.source.pageNumber, 2);
  assert.equal(fields.firstName.source.canvas.rotation, 90);
  assert.deepEqual(fields.firstName.source.region, { x0: 20, y0: 30, x1: 310, y1: 70 });
  assert.equal(fields.ssn.displayValue, '••••6789');
  assert.doesNotMatch(fields.ssn.evidence, /123-45-6789/);
});

test('withholds OCR candidates below the confidence threshold', () => {
  const result = parser.extractFieldsFromOcrPages([{
    pageNumber: 1,
    text: 'First Name: Maybe',
    confidence: 42,
    width: 800,
    height: 600,
    rotation: 0,
    lines: [{ text: 'First Name: Maybe', confidence: 42, bbox: null }],
  }]);
  assert.equal(result.fields.length, 0);
  assert.equal(result.withheld, 1);
});

test('uses stricter OCR thresholds for email and sensitive identifiers', () => {
  const result = parser.extractFieldsFromOcrPages([{
    pageNumber: 1,
    text: 'Email: testhava@email.com\nSSN: 123-45-6789',
    confidence: 92,
    width: 800,
    height: 600,
    rotation: 0,
    lines: [
      { text: 'Email: testhava@email.com', confidence: 90, bbox: null },
      { text: 'SSN: 123-45-6789', confidence: 89, bbox: null },
    ],
  }]);
  assert.equal(result.fields.length, 0);
  assert.equal(result.withheld, 2);
});

test('withholds OCR names containing common recognition artifacts', () => {
  const result = parser.extractFieldsFromOcrPages([{
    pageNumber: 1,
    text: 'Last Name: Thomas |',
    confidence: 95,
    width: 800,
    height: 600,
    rotation: 0,
    lines: [{ text: 'Last Name: Thomas |', confidence: 95, bbox: null }],
  }]);
  assert.equal(result.fields.length, 0);
  assert.equal(result.withheld, 1);
});

test('does not let OCR overwrite a higher-confidence embedded value', () => {
  const embedded = parser.extractFieldsFromText('First Name: Maria');
  const ocrField = { ...embedded[0], value: 'Marta', confidence: 'medium', ocrConfidence: 99 };
  const merged = byKey(parser.mergeFields(embedded, [ocrField]));
  assert.equal(merged.firstName.value, 'Maria');
});
