# Implementation notes

## Source-to-extension mapping

| Foad's protocol | Chrome extension implementation |
|---|---|
| Phase 0 — find and freshness-check a site playbook | The content agent recognizes the three bundled domains and probes known selectors on the live page. A missing probe downgrades the playbook to partial; the live scan and readback still govern every write. |
| Phase 1 — find the form | The page agent inventories visible `input`, `select`, and `textarea` elements. It removes search controls, hidden controls, honeypots, uploads, passwords/OTP/payment fields, bot-check fields, and legal attestation controls. An approved informational page with no fields can still advance through its exact allowlisted continuation. |
| Phase 2 — gap analysis and one question batch | `shared/form-engine.js` canonicalizes the participant payload, classifies visible fields, groups Yes/No controls, refuses protected inferences, and returns ready/changed/missing/decision/no-place collections. The side panel renders all missing questions in one view. |
| Phase 3 — gate-ordered fill | Assignments stay in DOM order. Radio and checkbox writes are idempotent. Select values are matched to the page's exact options. Each tab has its own application state. |
| Phase 4 — verify every write | The content agent immediately reads each field after writing. It compares digits for masks, retries text controls with an incremental event sequence, and returns a plain-language blocked reason for hidden, disabled, maxlength, stale, or rejected fields. |
| Phase 5 — exceptions | A failed field is left in `blocked` state and shown to the caseworker. The prototype does not persist newly learned site facts because it has no authenticated backend knowledge store. |
| Phase 6 — human submit gate | A bounded runner fills, verifies, and advances across approved pages. It stops on unanswered/blocked fields, bot checks, unknown controls, repeated pages, certification/signature language, or final actions. There is no message or code path that clicks submit. |

## Architecture

```text
sidepanel/
  sidepanel.js        workflow, document review, questions, dashboard, provenance review
  document-parser.js  local image/PDF/DOCX/text/delimited/JSON extraction and review policy
  ocr-engine.js       bounded local OCR, rotation correction, confidence + region evidence
        │
        ├── vendor/                    bundled PDF.js, fflate, Tesseract.js, WASM + English data
        ├── chrome.storage.session     participant values + live application details
        ├── chrome.storage.local       connector config + sanitized durable queue metadata
        ├── shared/connector-engine.js label-based schema mapping, validation, provenance
        ├── shared/work-queue-engine.js resume fingerprints, leases, handoff, audit sanitization
        ├── background.js              connector adapter, side-panel setup, open known tabs
        └── content/form-agent.js     scan → write → readback in the active page
                    │
                    └── shared/form-engine.js
                        deterministic mapping, gap analysis, transformations

Nava connector service
  authenticated read-only GET endpoints → health, labeled schema, raw record
  provider credentials remain server-side
```

All executable extension code ships inside the package; there are no remote scripts or analytics calls. Document parsing remains on-device. A configured managed lookup sends the opaque connection/form/record identifiers to the organization's Nava connector service and receives the requested record through the signed-in browser session.

## Document intake safety model

1. The file picker accepts PDF, PNG, JPEG, WebP, DOCX, TXT, CSV, TSV, and JSON files no larger than 15 MB.
2. Parsing runs in the side panel with bundled code. The extension keeps only proposed fields in memory and does not retain the raw file or extracted document text.
3. Free-form extraction is conservative: values must have recognized labels, except for common email, phone, US address, and city/state/ZIP patterns. SSNs and EINs must be explicitly labeled.
4. All OCR proposals start unchecked. The caseworker must compare page/region evidence and explicitly select each value. Conflicts and low-confidence non-OCR values also start unchecked.
5. Sensitive values remain masked in evidence and review UI. The selected underlying value stays in session storage so it can be written to a matching form field.
6. PDFs are capped at 60 pages and 750,000 embedded-text characters. Only the first 8 image-only pages are eligible for OCR.
7. OCR is capped at 8 million pixels per attempt, 32 million total processed pixels, 10 attempts, 30 seconds to start, and 45 seconds per page. One worker is created per document and always terminated.
8. OCR uses a pinned, bundled English fast model. It performs a bounded 90°/270° retry only when the first orientation is weak.
9. The parser withholds OCR below 70% confidence, requires 94% for email and 90% for SSN/EIN, and rejects common recognition artifacts in names. Accepted OCR is never labeled high-confidence.
10. Handwriting and unsupported languages are expected to abstain. Production use still requires representative pilot data, malware validation, accessibility review, and a privacy/security assessment.

## Deliberate product choices

1. **Structured-first, not chat-first.** The interface uses status cards, one question batch, and a provenance table. It does not render agent narration.
2. **Allowlisted cross-page control.** The runner advances only on a known domain (or the explicit local fixture) and an exact safe label. It rechecks the page immediately before clicking, keeps a page-signature history, stops after 12 pages, and denies all final-action language.
3. **No Apricot secret in Chrome.** The self-service UI stores only a sanitized service URL, opaque connection ID, form ID, freshness policy, labeled schema, and reviewed mapping. `LOOKUP_RECORD` calls a Nava-controlled, credentialed, read-only endpoint; Apricot credentials and organization authorization belong to the service.
4. **No debugger permission.** Chrome debugger access can create trusted input events, but it grants broad inspection power. Rejected masked fields are handed to the caseworker instead.
5. **No durable participant storage.** Client data uses `chrome.storage.session`, which is cleared when the browser session ends. The durable queue stores only workflow metadata, application origins, and opaque URL/page checksums. A restart therefore requires reloading the authorized source before resume.
6. **Verified resume, not blind replay.** Every resume starts with a read-only scan and rejects missing tabs, stale or expired sources, unaccepted handoffs, changed locations, or changed page signatures before any write.
7. **Local handoff boundary.** Version 0.6 models assignment, acceptance, named checkpoints, and same-profile write leases. Real multi-caseworker synchronization and identity enforcement belong in an authenticated Nava service.

## Recommended production follow-on

1. Replace the fictional loopback connector with the organization-authenticated Nava service, server-side provider credentials, least-privilege read scopes, and a sandbox tenant.
2. Convert the Markdown playbooks to versioned JSON delivered by that backend, with `confirmedAt`, `probeSelectors`, allowed transforms, and per-page field maps.
3. Move the bundled navigation policy into versioned, signed server playbooks. Keep every allowed Begin/Next/Continue label explicit and continue denying all submit-adjacent text.
4. Add organization-managed domain allowlists and remove broad `http://*/*` / `https://*/*` host access.
5. Move value-free queue events and ownership leases to an authenticated service so authorized caseworkers can coordinate across devices without copying source values into queue records.
6. Add policy-controlled, PII-free checkpoint notifications and immutable server-side audit retention.
7. Security-review extension updates, backend authentication, CORS/CSP, managed deployment, incident logging, and all handling of PII before pilot use.
