(async function runParserFixture() {
  'use strict';

  const fixtures = {
    pdf: { name: 'sample-client.pdf', type: 'application/pdf' },
    docx: { name: 'sample-business.docx', type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
    csv: { name: 'sample-business.csv', type: 'text/csv' },
  };
  const key = new URLSearchParams(location.search).get('fixture') || 'pdf';
  const fixture = fixtures[key];
  const status = document.getElementById('status');
  const resultElement = document.getElementById('result');

  try {
    if (!fixture) throw new Error('Unknown fixture. Use pdf, docx, or csv.');
    const response = await fetch(`fixtures/${fixture.name}`);
    if (!response.ok) throw new Error(`Fixture failed to load (${response.status}).`);
    const file = new File([await response.arrayBuffer()], fixture.name, { type: fixture.type });
    const result = await globalThis.NavaDocumentParser.parseDocument(file);
    resultElement.textContent = JSON.stringify(result, null, 2);
    status.textContent = `Parsed ${result.fields.length} fields from ${fixture.name}`;
    document.body.dataset.status = 'ready';
  } catch (error) {
    status.textContent = error.message;
    document.body.dataset.status = 'error';
    resultElement.textContent = error.stack || error.message;
  }
})();
