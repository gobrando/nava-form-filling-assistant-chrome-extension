const affirmation = document.getElementById('affirm');
const submit = document.getElementById('submit');
const form = document.getElementById('application-form');
const result = document.getElementById('result');

affirmation.addEventListener('change', () => {
  submit.disabled = !affirmation.checked;
});

form.addEventListener('submit', (event) => {
  event.preventDefault();
  result.textContent = 'Demo only: no application was sent.';
});
