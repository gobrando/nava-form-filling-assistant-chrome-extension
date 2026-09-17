(function runMultiPageFixture() {
  'use strict';

  const params = new URLSearchParams(location.search);
  const step = Math.min(3, Math.max(1, Number(params.get('step')) || 1));
  const form = document.getElementById('application-form');
  const stepNames = ['About the applicant', 'Home address', 'Review and submit'];
  const pageMarkup = {
    1: `
      <div class="intro"><p class="eyebrow">Step 1</p><h1>About the applicant</h1><p>Start with the client’s identity details.</p></div>
      <div class="grid two">
        <label>First name<input autocomplete="given-name" required></label>
        <label>Middle name<input autocomplete="additional-name"></label>
        <label>Last name<input autocomplete="family-name" required></label>
        <label>Date of birth<input id="birthDate" placeholder="MM/DD/YYYY" maxlength="10" required></label>
      </div>
      <button type="button" data-next>Next</button>`,
    2: `
      <div class="intro"><p class="eyebrow">Step 2</p><h1>Home address</h1><p>Tell us where the client currently lives.</p></div>
      <div class="grid two">
        <label>Street address<input autocomplete="address-line1" required></label>
        <label>Apartment or unit<input autocomplete="address-line2"></label>
        <label>City<input autocomplete="address-level2" required></label>
        <label>State<input autocomplete="address-level1" maxlength="2" required></label>
        <label>ZIP code<input autocomplete="postal-code" maxlength="5" required></label>
      </div>
      <button type="button" data-next>Save and continue</button>`,
    3: `
      <div class="intro"><p class="eyebrow">Step 3</p><h1>Review and submit</h1><p>Confirm contact details before the caseworker certifies and submits.</p></div>
      <div class="grid two">
        <label>Email<input type="email" autocomplete="email" required></label>
        <label>Mobile phone<input type="tel" autocomplete="tel" maxlength="10" required></label>
        <label>Primary language<input autocomplete="language"></label>
      </div>
      <label class="inline"><input type="checkbox" id="certify"> I certify that the information is correct.</label>
      <button type="submit">Submit application</button>
      <p id="result" role="status"></p>`,
  };

  document.title = `${stepNames[step - 1]} — Multi-page fixture`;
  document.getElementById('step-label').textContent = `Step ${step} of 3`;
  document.getElementById('steps').innerHTML = stepNames.map((name, index) =>
    `<li class="${index + 1 === step ? 'active' : ''}">${index + 1 < step ? '✓ ' : ''}${name}</li>`).join('');
  form.innerHTML = pageMarkup[step];

  form.querySelector('[data-next]')?.addEventListener('click', () => {
    params.set('step', String(step + 1));
    location.search = params.toString();
  });
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    document.getElementById('result').textContent = 'Fixture only: nothing was submitted.';
  });

})();
