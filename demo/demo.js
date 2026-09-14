const affirmation = document.getElementById('affirm');
const submit = document.getElementById('submit');
const form = document.getElementById('application-form');
const result = document.getElementById('result');
const testOutput = document.getElementById('test-output');
const testParticipant = {
  record_id: '339619',
  participant: {
    name: { first: 'Celeste', middle: 'NAVA', last: 'Thomas II' },
    date_of_birth: '2000-01-02',
  },
  contact_information: {
    phones: { cell: '9515551212' },
    email: 'celeste@example.org',
  },
  address: { residential: { state: 'California' } },
};

affirmation.addEventListener('change', () => {
  submit.disabled = !affirmation.checked;
});

form.addEventListener('submit', (event) => {
  event.preventDefault();
  result.textContent = 'Demo only: no application was sent.';
});

document.getElementById('scan-test').addEventListener('click', async () => {
  const response = await globalThis.NavaPageAgentTestApi.scan(testParticipant);
  globalThis.__demoAnalysis = response.analysis;
  testOutput.textContent = `${response.analysis.counts.fields} fields found\n${response.analysis.counts.ready} ready\n${response.analysis.counts.missing} questions`;
});

document.getElementById('fill-test').addEventListener('click', async () => {
  const scan = await globalThis.NavaPageAgentTestApi.scan(testParticipant);
  const response = await globalThis.NavaPageAgentTestApi.fill(scan.analysis.assignments);
  testOutput.textContent = `${response.verifiedCount} writes verified\n${response.blockedCount} blocked\nSubmit action: unavailable`;
});
