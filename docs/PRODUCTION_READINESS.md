# Production-readiness evidence

Date: 2026-09-17

## Executive answer

The extension implements an autonomous runner intended to complete a sequence of pages **up to the final review/submit page** when the site has an approved playbook, every required value is available and explicitly mapped, the page exposes a safe continuation control, and no human checkpoint intervenes. It keeps the imported client record in the browser session, reads every write back, and carries progress across pages. It never certifies, signs, attests, or submits. This revised build still requires a fresh installed-extension end-to-end run before that behavior is treated as validated evidence.

This is prototype implementation plus unit/static evidence, not a production-accuracy claim. The repository has not been connected to Nava's or a client's production Apricot tenant, has not processed real participant PII, and has not completed a live BenefitsCal application in a sanctioned test environment. Those validations require organization authorization, non-production credentials/data, privacy and security approval, and a test path that cannot create a real benefits case.

## What was tested

| Evidence | Result | What it establishes |
| --- | --- | --- |
| Automated suite | 127 tests pass | Mapping, formatting, delayed-validation readback, exact IHSS/WIC adapters, semantic checkbox values, conditional rescans, BenefitsCal route gates, repeated-entity abstention, coordinator races, sibling-safe partial persistence, bounded fill batches, OCR, connector boundaries, program grouping, resumability, handoff, and durable PII controls behave as specified. |
| Extensive local benefits fixture | 28 of 28 source-backed fields map in the engine test; the fixture is passive and contains no embedded participant or autofill runner | The synthetic record covers demographic, identity, contact, address, household, citizenship, income, childcare, and unemployment fields without letting the demo bypass the extension. An installed-extension browser rerun is required after each unpacked-extension reload. |
| Original three-page fixture | Passive fixture retains safe navigation and a final submit guard | It can exercise the installed extension, but opening the fixture URL alone performs no work. |
| Connector UI preview | 28 labeled source fields mapped; fictional record `339619` reviewed and imported in simulated preview state | The provider-neutral selection, mapping, review, and import UI state machine works with fictional data; preview mode does not contact the loopback adapter. |
| Mock connector probes | 28 schema fields, 28 record fields, non-GET rejected with HTTP 405 | The included adapter is read-only and returns the expected extensive fictional record. |
| Live application read-only checks | BenefitsCal public preamble reached language preferences; current IHSS intake and WIC routes loaded | Current routes and public navigation were inspected without entering applicant answers. This does not establish live form-fill correctness. |

The extensive fixture uses the fictional Celeste test record and deliberately exercises more than basic identity: SSN, date of birth, language, gender, ethnicity, marital status, disability/special-needs indicator, farm-worker indicator, pregnancy, preferred contact method, housing status, household size, citizenship status, monthly income, childcare, and unemployment benefits.

## What “filled correctly” means in this build

For each page, the assistant:

1. classifies visible controls from their labels, ARIA text, autocomplete metadata, type, options, and constraints;
2. proposes only values that exist in the reviewed source record;
3. writes in document order and dispatches native input/change events;
4. reads the rendered control value back and compares it with the expected normalized value; and
5. advances only when every proposed write verifies and the next action matches the safe allowlist.

A successful installed-extension run would establish **mechanical correctness against that inspected page and source record**. The current read-back implementation is a safety mechanism, not yet browser-run evidence. It does not establish legal or program eligibility, that the source system is current, that a caseworker selected the right person, or that every production site's business rules were interpreted correctly. Those remain human and pilot-validation responsibilities.

## Autonomous-run boundaries

The runner pauses instead of guessing when it encounters:

- a missing, ambiguous, conflicting, or stale source value;
- CAPTCHA, bot challenge, one-time code, login, or another direct-entry checkpoint;
- an unknown host, changed page signature, loop, unexpected navigation, or the playbook-specific page limit capped at 60;
- a control inside an unsupported cross-origin frame or closed shadow root;
- a mask or widget that rejects synthetic browser events; or
- certification, attestation, signature, final review, Finish, Complete, Apply, or Submit.

The caseworker does **not** need to reload the client on every page. The imported record remains in `chrome.storage.session` and the approved runner scans and fills each next page automatically. A full browser-session restart intentionally discards the values; the durable queue preserves the checkpoint and requires the source record to be reauthorized/reloaded before writes resume.

Selecting multiple known applications now starts their tab-bound runs immediately, with at most three active at once. CalFresh, Medi-Cal, and CalWORKs are grouped into one BenefitsCal application rather than three duplicate tabs. The side panel must remain open while this local coordinator runs; a production unattended queue requires a service-worker/server coordinator and authenticated recovery.

## Production validation still required

Before describing the product as production-ready, complete all of the following:

- Obtain a client-approved Apricot sandbox or test tenant and use synthetic records with production-representative schemas, field IDs, access controls, freshness, pagination, rate limits, and schema drift.
- Run a sanctioned BenefitsCal or agency-owned non-production application through every supported household composition and checkpoint, without creating a real submission.
- Add authenticated organization connections, server-side secret custody, tenant isolation, revocation, audit/retention controls, and mapping re-review on schema change.
- Test household-member repeaters, document uploads, address validation, dynamic conditional questions, account creation/login, save-and-return, renewals, case identifiers, and accessibility with assistive technology.
- Complete privacy, security, legal, accessibility, incident-response, and human-factors reviews.

## Decision

This build is suitable for design/engineering review and becomes a candidate for a controlled synthetic-data pilot after the installed-extension end-to-end rerun passes. It is **not yet suitable for unattended use with real applicants or production case-management credentials**.
