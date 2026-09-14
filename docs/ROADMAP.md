# Product roadmap recommendation

## Status of the three candidate areas

### Document upload extractor — prototype complete

The extension now parses PDF, DOCX, TXT, CSV, TSV, and JSON locally, proposes clearly labeled demographic, identity, address, contact, and business fields, masks SSN/EIN evidence, and requires review before merge. The remaining work is production hardening: OCR for image-only documents, encrypted backend extraction for layouts that deterministic parsing cannot handle, more formats, malware scanning, retention controls, and extraction-quality evaluation.

### Multi-application UI — useful foundation complete

The dashboard can track separate application tabs, retain one session client, show attention states, and produce cross-page progress. The next layer is operational: resumable sessions, notifications for human checkpoints, ownership/hand-off, and audit export.

### Self-service database connector — recommended next

This is the highest-leverage next feature. The form writer and document intake now have a trustworthy canonical record boundary, but caseworkers still need bundled test data, pasted JSON, or document upload. A connector turns the prototype into a repeatable workflow and removes the most frequent manual step before filling begins.

## Proposed first connector release

1. Build a Nava-controlled connector service; never place Apricot or other source-system secrets in the extension.
2. Start read-only with Apricot 360 because the current UI and sample records already use its record-ID mental model.
3. Add organization-admin OAuth/credential setup, least-privilege scopes, connection health, revocation, and audit logs.
4. Provide a self-service schema-mapping screen from source fields to the extension's canonical participant/business schema.
5. Preview the fetched record and require caseworker confirmation before it enters the browser session.
6. Attach field-level source/provenance and retrieval time to every filled value.
7. Ship contract tests, a sandbox tenant, retry/rate-limit behavior, and an explicit stale-record warning.

## Suggested sequence

- **Now:** Apricot read-only connector and schema mapping.
- **Next:** OCR/evaluation hardening for document intake.
- **Then:** resumable multi-application work queues and caseworker hand-off.
- **Later:** additional data sources through the same connector contract.

Success for the connector milestone: a new organization can configure a read-only source, map its schema, retrieve a participant by ID, review the normalized record, and launch the multi-page runner without engineering assistance or copied JSON.
