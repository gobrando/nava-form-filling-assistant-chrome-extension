# Production-readiness evidence

Date: 2026-09-25

## Executive answer

The extension implements an autonomous runner intended to complete a sequence of pages **up to the final review/submit page** when the site has an approved playbook, every required value is available and explicitly mapped, the page exposes a safe continuation control, and no human checkpoint intervenes. It keeps the imported client record in the browser session, reads every write back, and carries progress across pages. It never certifies, signs, attests, or submits. On 2026-09-23, an installed Chrome run with the downloaded on-device model reached the passive extensive fixture's Step 6 review page after recording all 28 fields across five data-entry pages. The certification checkbox remained unchecked and Submit was not activated.

This is prototype implementation plus unit, fixture, and synthetic-data live-site evidence—not a production-accuracy claim. The repository has not been connected to Nava's or a client's production Apricot tenant, has not processed real participant PII, and has not completed a live BenefitsCal application through review. The 2026-09-25 live tests used only bundled fictional data and stopped before submission.

The controller now includes a runtime-neutral LLM planning layer: separate Gemini Nano sessions or paired Codex/Claude subscription CLI calls propose mappings, identify gaps, and independently review the proposal before a deterministic local validator permits any value to reach the page executor. Unit evidence establishes role separation, schema-constrained output handling, omission of participant values from prompts, rejection of reviewer-invented mappings, subscription-bridge restrictions, and safe per-role queuing across parallel application plans. Installed live IHSS evidence now exists for Gemini Nano and Codex, but neither run achieved complete required-field coverage.

## What was tested

| Evidence | Result | What it establishes |
| --- | --- | --- |
| Automated suite | 161 tests pass | Three-agent planning across on-device and subscription-companion runtimes, value-minimized and size-bounded prompts, reviewer/local-policy enforcement, Codex token accounting, known-site path policy, guarded BenefitsCal navigation, mapping, delayed-validation readback, exact IHSS/WIC adapters, conditional rescans, coordinator races, CAPTCHA/OTP checkpoints, OCR, connector boundaries, resumability, handoff, and durable PII controls behave as specified. |
| Installed extensive local benefits fixture | Chrome reached Step 6; 28 of 28 fields recorded across five of five data-entry pages; certification remained unchecked; no browser warnings or errors | The installed extension—not fixture-local code—performed the scan/plan/fill/advance loop and stopped at review. This is local synthetic evidence, not live-site production evidence. |
| Original three-page fixture | Passive fixture retains safe navigation and a final submit guard | It can exercise the installed extension, but opening the fixture URL alone performs no work. |
| Connector UI preview | 28 labeled source fields mapped; fictional record `339619` reviewed and imported in simulated preview state | The provider-neutral selection, mapping, review, and import UI state machine works with fictional data; preview mode does not contact the loopback adapter. |
| Mock connector probes | 28 schema fields, 28 record fields, non-GET rejected with HTTP 405 | The included adapter is read-only and returns the expected extensive fictional record. |
| Live application diagnostics | BenefitsCal public preamble reached language preferences; current IHSS intake and WIC routes loaded; a user-initiated fictional WIC run exposed a stale-gap and singleton-checkbox defect | Version 0.10.0 includes the 0.9.4 fix that removes model gaps for already mapped values, preserves writable checkbox IDs, trusts versioned site hints, and groups missing RUHS checkbox decisions into the two select-all-that-apply questions shown by the site. The live WIC flow must be re-run after reloading 0.10.0; this does not establish end-to-end live correctness. |
| Live IHSS benchmark | Gemini Nano verified 32/35 attempted writes; Codex verified 34/37; both stopped before affirmation, Cloudflare, and Submit | Both runtimes perform real planning and DOM execution on a complex live form. Neither run was review-ready because several required decision groups remained unanswered. |
| Live BenefitsCal diagnostic | Codex verified the language-preference page and reached the live name-information route, then paused on a path-policy bug | The site-specific continuation worked. The known-site path fix is implemented and must be rerun after extension reload before any end-to-end claim. |

The extensive fixture uses the fictional Celeste test record and deliberately exercises more than basic identity: SSN, date of birth, language, gender, ethnicity, marital status, disability/special-needs indicator, farm-worker indicator, pregnancy, preferred contact method, housing status, household size, citizenship status, monthly income, childcare, and unemployment benefits.

## What “filled correctly” means in this build

For each page, the assistant:

1. inventories visible controls from their labels, ARIA text, autocomplete metadata, type, options, and constraints;
2. asks the field-mapping and gap-analysis agents for schema-constrained proposals and requires an independent review agent plus a local allowlist check;
3. resolves only approved purposes to values that actually exist in the reviewed source record—the model never sees those values;
4. writes in document order and dispatches native input/change events;
5. reads the rendered control value back and compares it with the expected normalized value; and
6. advances only when every proposed write verifies and the next action matches the safe allowlist.

The installed fixture run establishes **mechanical correctness against that synthetic inspected flow and source record**. The read-back implementation does not establish legal or program eligibility, that the source system is current, that a caseworker selected the right person, or that production-site business rules were interpreted correctly. Those remain human and pilot-validation responsibilities.

## Autonomous-run boundaries

The runner pauses instead of guessing when it encounters:

- a missing, ambiguous, conflicting, or stale source value;
- CAPTCHA, bot challenge, one-time code, login, or another direct-entry checkpoint; after a caseworker completes a CAPTCHA or code challenge, an explicit resume action rescans the page before automation continues;
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
