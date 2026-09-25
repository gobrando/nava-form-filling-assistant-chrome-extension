# Live model benchmark

This benchmark compares the same extension planner/executor architecture across
actual public benefits application sites. It uses only the bundled synthetic
Celeste record, permits normal intermediate page saves, and never activates a
certification, signature, CAPTCHA, or final submit control.

## What is measured

- **Planner latency:** summed duration for mapper, gap analyst, and reviewer.
- **Provider usage:** Gemini context units or provider-reported input/output tokens.
- **Write verification:** values that survived input/change events and readback.
- **Coverage:** verified writes divided by visible fields detected by the extension.
- **Gap quality:** whether every known missing or blocked answer is surfaced clearly.
- **Outcome:** review-ready, correctly paused for a real gate, or failed/incomplete.

Readback proves that a value remained in the intended control; it does not by
itself prove semantic correctness. Each run therefore also includes a redacted
manual adjudication of source-backed omissions and incorrect gaps.

Run `npm run eval:models` for the current comparison table. Raw sanitized activity
logs are kept beside the adjudicated results so reviewers can audit every count.
