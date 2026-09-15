# Product roadmap recommendation

## Status of the three candidate areas

### Self-service database connector — vertical slice complete

Version 0.4 delivers the extension-side connector milestone against a loopback contract fixture. An organization can enter a managed service URL and opaque connection ID, test access, load labeled Apricot fields, review suggested mappings, retrieve and confirm a fictional record with field-level provenance and freshness, and launch the existing multi-page runner without pasting JSON.

The extension rejects secret-like configuration, requires HTTPS outside localhost, keeps participant records in session storage, and never assigns meaning from a numeric Apricot field ID. The production backend remains separate work: organization authentication, provider credential custody, a sandbox tenant, revocation, rate limits, audit events without values, and current Bonterra/partner approval.

### Document upload extractor — OCR and evaluation vertical slice complete

Version 0.5 adds bundled English OCR for PNG, JPEG, WebP, and image-only PDF pages; strict page/pixel/attempt/time budgets; rotation recovery; page/region/confidence provenance; default-unchecked OCR proposals; and an executable quality gate. The synthetic corpus currently passes at 100% precision, 91.2% recall, 100% expected-abstention accuracy, zero accepted wrong values, and zero sensitive evidence leaks. The next extraction work is pilot-grade hardening against representative, consented documents rather than broader automatic acceptance.

### Multi-application UI — useful foundation complete

The dashboard tracks separate application tabs, retains one session client, shows attention states, runs approved multi-page flows, and produces cross-page progress. The next layer is operational: resumable sessions, notifications for human checkpoints, ownership/hand-off, and audit export.

## Completed milestone: OCR and extraction evaluation

Before adding more intake automation, establish a measurable quality bar and preserve the current bias against invented data.

1. Build a consent-safe evaluation corpus of fictional and redacted documents, including clean PDFs, scans, rotated pages, low contrast, tables, handwriting, and bilingual layouts.
2. Report field-level precision, recall, conflict handling, sensitive-value masking, and document-level “safe to review” coverage. Treat a wrong confident value as more costly than an omitted value.
3. Add bounded on-device OCR for image-only PDFs and common image formats, with page, pixel, language, time, and memory limits.
4. Retain page/region provenance and OCR confidence so the caseworker can compare every proposed value with its source.
5. Route low-confidence, ambiguous, handwritten, or unsupported content to manual entry. Do not infer protected or eligibility facts.
6. Add malware/file-type validation, encrypted temporary handling, retention tests, accessibility checks, and performance budgets before a pilot.

The repository now provides the implementation and a reproducible synthetic baseline for those success criteria. A real pilot must add representative consented/redacted documents and accessibility, malware, performance, and privacy validation before these numbers can be generalized.

## Recommended next milestone: resumable multi-application work queues

The best next extension-side investment is making the existing multi-application dashboard operational across real caseworker interruptions while production connector work proceeds with backend owners.

1. Persist minimal encrypted work-queue metadata without persisting raw documents or participant values longer than policy allows.
2. Make paused applications resumable at a verified URL/page signature, then rescan before any write.
3. Add explicit ownership, hand-off, and human-checkpoint states for CAPTCHA, OTP, certification, signature, and final submit.
4. Add value-free audit export for opened, scanned, prompted, filled, verified, blocked, resumed, and review-reached events.
5. Add notifications only for actionable human checkpoints, with organization policy controls and no PII in notification content.
6. Test recovery from tab closure, browser restart, expired sessions, stale records, changed forms, and two caseworkers attempting the same application.

Success: a caseworker can safely leave and resume several applications without reloading the source document or silently replaying stale writes, and another authorized caseworker can understand exactly why an application paused.

## Suggested sequence

- **Completed:** OCR and extraction-quality evaluation baseline.
- **In parallel with backend owners:** productionize the Nava connector service and pilot one authenticated Apricot organization.
- **Next:** resumable multi-application work queues and caseworker hand-off.
- **Later:** additional source systems through the same connector contract.

## Connector follow-through before production

- Replace the loopback fixture with the organization-authenticated Nava service.
- Restrict CORS and Chrome host permissions to managed deployment IDs and approved domains.
- Add connection health, revocation, credential rotation, retry/backoff, and value-free audit events.
- Validate mappings against a sandbox tenant and require re-review when source labels or form schema drift.
- Run a privacy, threat-model, accessibility, and incident-response review before processing real participant data.
