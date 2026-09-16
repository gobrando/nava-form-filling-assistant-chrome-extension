# Product roadmap recommendation

## Status of the three candidate areas

### Self-service database connector — provider-neutral extension slice complete

Version 0.7 generalizes the extension-side connector milestone against a provider-neutral contract. An organization can choose a source type, enter a managed service URL and opaque connection ID, test access, load labeled source fields, review suggested mappings, retrieve and confirm a fictional record with field-level provenance and freshness, and launch the multi-page runner without pasting JSON.

The extension rejects secret-like configuration, requires HTTPS outside localhost, keeps participant records in session storage, and never assigns meaning from an opaque provider field ID. The catalog covers Apricot, Salesforce Nonprofit, Bitfocus Clarity, WellSky Community Services, Eccovia ClientTrack, CaseWorthy, Foothold AWARDS, and Bonterra ETO. Only the fictional Apricot-shaped loopback adapter is runnable; the production backend and every authorized provider adapter remain separate work.

This is not yet a Plaid-like provider network. That requires organization authentication, provider discovery, OAuth/admin authorization, secret custody, live adapters, connection health and revocation, schema-drift review, tenant isolation, and provider sandbox/contract validation.

### Document upload extractor — OCR and evaluation vertical slice complete

Version 0.5 adds bundled English OCR for PNG, JPEG, WebP, and image-only PDF pages; strict page/pixel/attempt/time budgets; rotation recovery; page/region/confidence provenance; default-unchecked OCR proposals; and an executable quality gate. The synthetic corpus currently passes at 100% precision, 91.2% recall, 100% expected-abstention accuracy, zero accepted wrong values, and zero sensitive evidence leaks. The next extraction work is pilot-grade hardening against representative, consented documents rather than broader automatic acceptance.

### Multi-application UI — useful foundation complete

The dashboard tracks separate application tabs, retains one session client, shows attention states, runs approved multi-page flows, and produces cross-page progress.

## Completed milestone: OCR and extraction evaluation

Before adding more intake automation, establish a measurable quality bar and preserve the current bias against invented data.

1. Build a consent-safe evaluation corpus of fictional and redacted documents, including clean PDFs, scans, rotated pages, low contrast, tables, handwriting, and bilingual layouts.
2. Report field-level precision, recall, conflict handling, sensitive-value masking, and document-level “safe to review” coverage. Treat a wrong confident value as more costly than an omitted value.
3. Add bounded on-device OCR for image-only PDFs and common image formats, with page, pixel, language, time, and memory limits.
4. Retain page/region provenance and OCR confidence so the caseworker can compare every proposed value with its source.
5. Route low-confidence, ambiguous, handwritten, or unsupported content to manual entry. Do not infer protected or eligibility facts.
6. Add malware/file-type validation, encrypted temporary handling, retention tests, accessibility checks, and performance budgets before a pilot.

The repository now provides the implementation and a reproducible synthetic baseline for those success criteria. A real pilot must add representative consented/redacted documents and accessibility, malware, performance, and privacy validation before these numbers can be generalized.

## Completed milestone: resumable multi-application work queues and handoff

Version 0.6 makes the existing multi-application dashboard operational across ordinary caseworker interruptions while preserving the session-only client-data boundary.

1. Durable local state contains sanitized queue metadata and opaque page checksums, never participant values, raw documents, raw page signatures, or query strings.
2. A paused application resumes only after a live read-only scan verifies the saved URL fingerprint and page-signature fingerprint.
3. Ownership, pending/accepted handoffs, and named CAPTCHA, OTP, direct-entry, certification, signature, final-review, tab-closure, stale-source, and expired-source checkpoints are explicit.
4. A value-free audit export records workflow events and bounded counts, not answers.
5. Per-application leases prevent competing assistant panels in the same Chrome profile from writing concurrently and expire safely after interruption.
6. Automated tests cover restart recovery, tab closure, stale/expired sources, changed pages, pending handoffs, competing leases, and the durable PII boundary.

Because client values intentionally expire at browser-session end, a full browser restart requires source reauthorization/reload before filling can continue. This is a deliberate safety tradeoff, not silent loss: application progress and the exact checkpoint remain visible.

## Recommended next milestone: one authenticated connector pilot

The next meaningful step crosses the extension/backend boundary. Build the organization-authenticated queue and connector service needed for real multi-caseworker operation.

1. Synchronize encrypted, metadata-only assignments across authorized caseworkers; keep participant values in the source system rather than copying them into the queue.
2. Enforce server-side ownership leases, role-based access, handoff acceptance, revocation, retention, and immutable value-free audit events.
3. Add policy-controlled, PII-free notifications for actionable human checkpoints.
4. Pilot one Apricot organization in a sandbox tenant with synthetic records, current source freshness, mapping-drift detection, and approved application domains.
5. Exercise one sanctioned, non-production benefits application end to end with the extensive demographic and household test matrix; preserve the human final-submit boundary.
6. Complete accessibility, privacy, security, incident-response, and representative-document evaluation before any real-client use.

## Suggested sequence

- **Completed:** OCR and extraction-quality evaluation baseline.
- **Completed:** local resumable multi-application queue and same-profile handoff vertical slice.
- **Completed:** provider-neutral source catalog/contract and 28-field fictional adapter validation.
- **Next:** productionize the authenticated Nava connector and work-queue service; pilot one Apricot organization in a sandbox.
- **Later:** add provider adapters in priority order using the published [coverage matrix](CONNECTOR_COVERAGE.md).

## Connector follow-through before production

- Replace the loopback fixture with the organization-authenticated Nava service.
- Restrict CORS and Chrome host permissions to managed deployment IDs and approved domains.
- Add connection health, revocation, credential rotation, retry/backoff, and value-free audit events.
- Validate mappings against a sandbox tenant and require re-review when source labels or form schema drift.
- Run a privacy, threat-model, accessibility, and incident-response review before processing real participant data.
