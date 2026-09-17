# Work-queue security and recovery

Version 0.8 includes resumable multi-application work and a same-Chrome-profile caseworker handoff prototype. This document defines what survives interruption, what must expire, and which checks run before filling resumes.

## Storage boundary

| Data | Storage | Lifetime |
| --- | --- | --- |
| Participant and business values | `chrome.storage.session` | Current browser session |
| Parsed document proposals and provenance | `chrome.storage.session` after import; raw file is never stored | Current browser session |
| Live field inventory, assignments, and verification results | `chrome.storage.session` | Current browser session |
| Workflow ID, program IDs, application label, approved origin and catalog route prefixes, status, bounded progress counts, checkpoint, owner/handoff, tab ID, timestamps | `chrome.storage.local` | Until the caseworker ends or clears the session |
| Full URL path and query, raw page signature | Not stored durably | Live/session memory only |
| Opaque checksums of normalized origin/path and page signature | `chrome.storage.local` | Same as queue metadata |
| Audit event type, timestamp, workflow ID, approved enum details, bounded counts | `chrome.storage.local`; optional JSON export | Same as queue metadata or organization policy |

Durable metadata is sanitized but is not encrypted by the extension itself. Its checksums detect ordinary page changes; they are not cryptographic authorization controls and may be guessable for known paths. The prototype relies on the local Chrome profile and operating-system protections. A production deployment must apply organization policy, device management, authenticated server storage where needed, encryption at rest, retention limits, and remote revocation.

## Resume gate

The assistant does not replay saved writes. It first performs a new read-only scan and permits resume only when all of these conditions hold:

1. The participant source is loaded and not stale.
2. Any pending handoff has been accepted.
3. The application tab is open.
4. The normalized live location matches the saved location fingerprint.
5. The live page signature matches the saved page-signature fingerprint.

A failure creates a named checkpoint and leaves the page untouched. After a full browser restart, queue metadata survives but participant values do not, so **Reload client data** is the only permitted recovery path.

## Human checkpoints

CAPTCHA, incomplete one-time codes, direct-entry fields, missing answers, certification, signature, final review, unknown navigation, changed pages, and tab closure stop automation. Checkpoints contain a short operational label only; they do not contain client answers or free-form case notes.

## Ownership and concurrency

A handoff records a caseworker/team label, a constrained reason, creation time, and acceptance time. The recipient must accept before resume. Installed mode gives each loaded client an exclusive session token and each application a generation, revision, and central write lease. The service worker validates those values and starts the document-bound tab command in one serialized operation; a pause that wins the race prevents dispatch, while a pause after dispatch sends a cancellation command. Application-scoped reconciliation leaves unrelated workers running. Deterministic coordinator tests cover these races and lease expiry/release, but a two-panel installed-browser exercise is still pending.

This is not cross-device identity or authorization. Production handoff requires an authenticated organization queue service with server-enforced leases, role-based access, assignment visibility, revocation, immutable audits, and PII-free notifications.

## Audit contract

The exporter uses an allowlist of event types and detail keys. It records lifecycle events and bounded counts, but excludes participant names, field labels, values, answers, document text, full URLs, and raw page signatures. The export remains sensitive operational data and should follow organization retention and access policy.

## Tested recovery cases

- application tab closed;
- browser-session source expired;
- connector record stale;
- saved location changed;
- page structure/signature changed;
- handoff not yet accepted;
- a second assistant panel attempts to acquire an active lease; and
- an interrupted panel leaves an expired lease that must be reclaimed.
