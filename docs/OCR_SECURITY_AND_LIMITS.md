# OCR security, review policy, and limits

## Processing boundary

OCR runs inside the Chrome extension with bundled Tesseract.js code, WebAssembly cores, and a pinned English `tessdata_fast` model. The raw file, rendered canvases, OCR text, and OCR worker are not sent to a network service. The raw upload and extracted text are not written to Chrome storage; only caseworker-selected canonical values and compact provenance can enter session storage.

## Resource budgets

| Budget | Limit |
| --- | ---: |
| Upload size | 15 MB |
| PDF pages read for embedded text | 60 |
| Pages eligible for OCR | 8 |
| Pixels per OCR attempt | 8,000,000 |
| Total processed pixels per document | 32,000,000 |
| OCR attempts per document | 10 |
| Worker startup | 30 seconds |
| Recognition per page | 45 seconds |

One OCR worker is reused within a document and terminated in all exit paths. A weak first pass can trigger at most two orientation retries, at 90° and 270°, while the same attempt and pixel budgets continue to apply.

## Acceptance and review policy

- OCR values require a recognized field label and valid field shape.
- The base line-confidence floor is 70%. Email requires 94%; SSN/EIN requires 90%.
- Common OCR artifacts in person names are withheld.
- Accepted OCR is marked medium or low confidence, never high.
- Every OCR proposal includes page, region when available, recognition confidence, and corrected rotation.
- Every OCR proposal starts unchecked. A caseworker must verify and select it before merge.
- SSN/EIN evidence and evaluation output are masked to the final four digits.
- Embedded PDF text wins over OCR when its extraction confidence is higher.
- Unsupported handwriting and unsupported languages should abstain, not be guessed.

## Evaluation contract

`npm run ocr:fixtures` regenerates the deterministic synthetic images from `evaluation/corpus.json`. `npm run eval:extraction` runs the same OCR and field-acceptance policy and rewrites `evaluation/latest-report.json` and `evaluation/latest-report.md`.

The current gate requires at least 95% accepted-field precision, 80% recall, 100% expected abstention, zero accepted wrong values, and zero unmasked sensitive values in evidence. Precision and safe abstention are intentionally weighted above coverage.

## Before a pilot

The current corpus is small and synthetic. A pilot needs consented or properly redacted representative documents across scanners, cameras, forms, fonts, document ages, supported languages, and relevant disability/accessibility scenarios. Add file-signature and malware validation, retention tests, memory/latency measurements on managed devices, screen-reader and keyboard testing, a privacy and threat-model review, and a documented manual-entry fallback. Expansion to more languages should pin and evaluate each language model separately.
