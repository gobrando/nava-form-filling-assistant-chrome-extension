# Product roadmap recommendation

## Status of the three candidate areas

### Self-service database connector — vertical slice complete

Version 0.4 delivers the extension-side connector milestone against a loopback contract fixture. An organization can enter a managed service URL and opaque connection ID, test access, load labeled Apricot fields, review suggested mappings, retrieve and confirm a fictional record with field-level provenance and freshness, and launch the existing multi-page runner without pasting JSON.

The extension rejects secret-like configuration, requires HTTPS outside localhost, keeps participant records in session storage, and never assigns meaning from a numeric Apricot field ID. The production backend remains separate work: organization authentication, provider credential custody, a sandbox tenant, revocation, rate limits, audit events without values, and current Bonterra/partner approval.

### Document upload extractor — prototype complete; hardening is next

The extension parses PDF, DOCX, TXT, CSV, TSV, and JSON locally, proposes clearly labeled demographic, identity, address, contact, and business fields, masks SSN/EIN evidence, and requires review before merge. Image-only and scanned documents remain the largest coverage gap.

### Multi-application UI — useful foundation complete

The dashboard tracks separate application tabs, retains one session client, shows attention states, runs approved multi-page flows, and produces cross-page progress. The next layer is operational: resumable sessions, notifications for human checkpoints, ownership/hand-off, and audit export.

## Recommended next milestone: OCR and extraction evaluation

Before adding more intake automation, establish a measurable quality bar and preserve the current bias against invented data.

1. Build a consent-safe evaluation corpus of fictional and redacted documents, including clean PDFs, scans, rotated pages, low contrast, tables, handwriting, and bilingual layouts.
2. Report field-level precision, recall, conflict handling, sensitive-value masking, and document-level “safe to review” coverage. Treat a wrong confident value as more costly than an omitted value.
3. Add bounded on-device OCR for image-only PDFs and common image formats, with page, pixel, language, time, and memory limits.
4. Retain page/region provenance and OCR confidence so the caseworker can compare every proposed value with its source.
5. Route low-confidence, ambiguous, handwritten, or unsupported content to manual entry. Do not infer protected or eligibility facts.
6. Add malware/file-type validation, encrypted temporary handling, retention tests, accessibility checks, and performance budgets before a pilot.

Success: on a representative evaluation set, every imported value is traceable to visible source evidence; sensitive evidence stays masked; no unreviewed value reaches a form; and accuracy, abstention, latency, and failure behavior meet published thresholds.

## Suggested sequence

- **Now:** OCR and extraction-quality evaluation.
- **In parallel with backend owners:** productionize the Nava connector service and pilot one authenticated Apricot organization.
- **Then:** resumable multi-application work queues and caseworker hand-off.
- **Later:** additional source systems through the same connector contract.

## Connector follow-through before production

- Replace the loopback fixture with the organization-authenticated Nava service.
- Restrict CORS and Chrome host permissions to managed deployment IDs and approved domains.
- Add connection health, revocation, credential rotation, retry/backoff, and value-free audit events.
- Validate mappings against a sandbox tenant and require re-review when source labels or form schema drift.
- Run a privacy, threat-model, accessibility, and incident-response review before processing real participant data.
