(function runExtensiveFixture() {
  'use strict';

  const params = new URLSearchParams(location.search);
  const step = Math.min(6, Math.max(1, Number(params.get('step')) || 1));
  const form = document.getElementById('application-form');
  const output = document.getElementById('test-output');
  const historyKey = 'nava:extensive-fixture-history';
  if (step === 1 && params.get('reset') === '1') sessionStorage.removeItem(historyKey);
  const stepNames = [
    'Applicant identity',
    'Contact and address',
    'Demographics',
    'Household',
    'Income and expenses',
    'Review and submit',
  ];
  const yesNo = (name, question) => `
    <fieldset>
      <legend>${question}</legend>
      <label class="inline"><input type="radio" name="${name}" value="yes" required> Yes</label>
      <label class="inline"><input type="radio" name="${name}" value="no" required> No</label>
    </fieldset>`;

  const pageMarkup = {
    1: `
      <div class="intro"><p class="eyebrow">Step 1</p><h1>Applicant identity</h1><p>Identity values come from confirmed source labels.</p></div>
      <div class="grid two">
        <label>First name<input autocomplete="given-name" required></label>
        <label>Middle name<input autocomplete="additional-name"></label>
        <label>Last name<input autocomplete="family-name" required></label>
        <label>Date of birth<input id="birthDate" placeholder="MM/DD/YYYY" maxlength="10" required></label>
        <label>Social Security Number<input id="ssn" inputmode="numeric" maxlength="11" required></label>
      </div>
      <button type="button" data-next>Next</button>`,
    2: `
      <div class="intro"><p class="eyebrow">Step 2</p><h1>Contact and address</h1><p>Verify how to contact the applicant and where they live.</p></div>
      <div class="grid two">
        <label>Email<input type="email" autocomplete="email" required></label>
        <label>Mobile phone<input type="tel" autocomplete="tel" maxlength="10" required></label>
        <label>Street address<input autocomplete="address-line1" required></label>
        <label>Apartment or unit<input autocomplete="address-line2"></label>
        <label>City<input autocomplete="address-level2" required></label>
        <label>State<input autocomplete="address-level1" maxlength="2" required></label>
        <label>County<input name="county" required></label>
        <label>ZIP code<input autocomplete="postal-code" maxlength="5" required></label>
        <label>Country<input autocomplete="country-name" required></label>
      </div>
      <button type="button" data-next>Save and continue</button>`,
    3: `
      <div class="intro"><p class="eyebrow">Step 3</p><h1>Demographics</h1><p>These values are used only when the source record labels them explicitly.</p></div>
      <div class="grid two">
        <label>Primary language<select required><option value="">Choose</option><option>English</option><option>Spanish</option></select></label>
        <label>Gender<select required><option value="">Choose</option><option>Female</option><option>Male</option><option>Nonbinary</option></select></label>
        <label>Ethnicity<select required><option value="">Choose</option><option>Hispanic/Latino</option><option>Not Hispanic/Latino</option></select></label>
        <label>Marital status<select required><option value="">Choose</option><option>Single</option><option>Married</option><option>Other</option></select></label>
      </div>
      ${yesNo('special-needs', 'Does the applicant have special needs or a disability?')}
      ${yesNo('farm-worker', 'Is the applicant a farm worker?')}
      ${yesNo('pregnant', 'Is the applicant pregnant?')}
      <button type="button" data-next>Continue</button>`,
    4: `
      <div class="intro"><p class="eyebrow">Step 4</p><h1>Household</h1><p>Review household and eligibility-related details.</p></div>
      <div class="grid two">
        <label>Preferred contact method<select required><option value="">Choose</option><option>Email</option><option>Phone</option><option>Mail</option></select></label>
        <label>Housing status<select required><option value="">Choose</option><option>Stable housing</option><option>Temporary housing</option><option>Experiencing homelessness</option></select></label>
        <label>Household size<input type="number" min="1" required></label>
        <label>Citizenship status<select required><option value="">Choose</option><option>U.S. citizen</option><option>Qualified non-citizen</option><option>Prefer not to answer</option></select></label>
      </div>
      <button type="button" data-next>Next</button>`,
    5: `
      <div class="intro"><p class="eyebrow">Step 5</p><h1>Income and expenses</h1><p>Financial answers are never inferred.</p></div>
      <div class="grid two">
        <label>Monthly household income<input inputmode="decimal" required></label>
      </div>
      ${yesNo('childcare', 'Is the household paying for childcare?')}
      ${yesNo('unemployment', 'Does the applicant receive unemployment benefits?')}
      <button type="button" data-next>Continue</button>`,
    6: `
      <div class="intro"><p class="eyebrow">Step 6</p><h1>Review and submit</h1><p>The assistant must stop here for human review.</p></div>
      <div class="notice"><strong id="completion-summary">No field history is available yet.</strong><p>Review every answer before certification.</p></div>
      <label class="inline"><input type="checkbox" id="certify"> I certify that the information is correct.</label>
      <button type="submit">Submit application</button>
      <p id="result" role="status"></p>`,
  };

  function history() {
    return JSON.parse(sessionStorage.getItem(historyKey) || '[]');
  }

  function renderHistory() {
    const entries = history();
    const completed = entries.reduce((sum, item) => sum + Number(item.completed || 0), 0);
    const total = entries.reduce((sum, item) => sum + Number(item.fields || 0), 0);
    const completionSummary = document.getElementById('completion-summary');
    if (completionSummary) {
      completionSummary.textContent = `${completed} of ${total || 28} fixture fields recorded across ${entries.length} of 5 data-entry pages.`;
    }
    output.textContent = entries.length
      ? `${entries.map((item) => `Page ${item.step}: ${item.completed}/${item.fields} completed${item.missing?.length ? ` · missing ${item.missing.join(', ')}` : ''}`).join('\n')}\nFinal submission remains human-controlled.`
      : 'Waiting for the Chrome extension…';
  }

  function capturePage() {
    const controls = [...form.querySelectorAll('input:not([type="checkbox"]):not([type="radio"]), select')];
    const radioNames = [...new Set([...form.querySelectorAll('input[type="radio"]')].map((item) => item.name))];
    const completed = controls.filter((item) => String(item.value || '').trim()).length
      + radioNames.filter((name) => form.querySelector(`input[name="${CSS.escape(name)}"]:checked`)).length;
    const fields = controls.length + radioNames.length;
    const missing = [
      ...controls.filter((item) => !String(item.value || '').trim()).map((item) => item.closest('label')?.textContent?.trim() || item.name || item.id),
      ...radioNames.filter((name) => !form.querySelector(`input[name="${CSS.escape(name)}"]:checked`)),
    ];
    const entries = [...history().filter((item) => item.step !== step), { step, completed, fields, missing }].sort((a, b) => a.step - b.step);
    sessionStorage.setItem(historyKey, JSON.stringify(entries));
  }

  document.title = `${stepNames[step - 1]} — Extended benefits fixture`;
  document.getElementById('step-label').textContent = `Step ${step} of 6`;
  document.getElementById('steps').innerHTML = stepNames.map((name, index) =>
    `<li class="${index + 1 === step ? 'active' : ''}">${index + 1 < step ? '✓ ' : ''}${name}</li>`).join('');
  form.innerHTML = pageMarkup[step];
  renderHistory();

  form.querySelector('[data-next]')?.addEventListener('click', () => {
    capturePage();
    params.set('step', String(step + 1));
    location.search = params.toString();
  });
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    document.getElementById('result').textContent = 'Fixture only: nothing was submitted.';
  });

})();
