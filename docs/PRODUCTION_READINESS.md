# Production-readiness evidence

Date: 2026-09-16

## Executive answer

The extension can autonomously complete a sequence of pages **up to the final review/submit page** when the site has an approved playbook, every required value is available and explicitly mapped, the page exposes a safe continuation control, and no human checkpoint intervenes. It keeps the imported client record in the browser session, reads every write back, and carries progress across pages. It never certifies, signs, attests, or submits.

This is strong prototype evidence, not a production-accuracy claim. The repository has not been connected to Nava's or a client's production Apricot tenant, has not processed real participant PII, and has not completed a live BenefitsCal application in a sanctioned test environment. Those validations require organization authorization, non-production credentials/data, privacy and security approval, and a test path that cannot create a real benefits case.

## What was tested

| Evidence | Result | What it establishes |
| --- | --- | --- |
| Automated suite | 49 tests pass | Mapping, formatting, safety gates, OCR, connector boundaries, resumability, handoff, and durable PII controls behave as specified. |
| Extensive local benefits fixture | 28 of 28 source-backed fields verified across five data-entry pages; page six stopped at review | The runner can retain an imported record and advance autonomously through a longer demographic, identity, contact, address, household, citizenship, income, childcare, and unemployment flow. |
| Original three-page fixture | 12 of 12 writes verified; stopped at final review | The original smaller end-to-end path remains covered. |
| Connector browser walkthrough | 28 labeled source fields mapped; fictional record `339619` reviewed and imported | The provider-neutral extension flow works end to end with the loopback Apricot-shaped adapter. |
| Mock connector probes | 28 schema fields, 28 record fields, non-GET rejected with HTTP 405 | The included adapter is read-only and returns the expected extensive fictional record. |
| Live BenefitsCal read-only check | Public Apply flow exposed the expected Begin/Next navigation | The playbook's public routes and labels matched the live site when inspected. No application answers were entered. |

The extensive fixture uses the fictional Celeste test record and deliberately exercises more than basic identity: SSN, date of birth, language, gender, ethnicity, marital status, disability/special-needs indicator, farm-worker indicator, pregnancy, preferred contact method, housing status, household size, citizenship status, monthly income, childcare, and unemployment benefits.

## What “filled correctly” means in this build

For each page, the assistant:

1. classifies visible controls from their labels, ARIA text, autocomplete metadata, type, options, and constraints;
2. proposes only values that exist in the reviewed source record;
3. writes in document order and dispatches native input/change events;
4. reads the rendered control value back and compares it with the expected normalized value; and
5. advances only when every proposed write verifies and the next action matches the safe allowlist.

That establishes **mechanical correctness against the inspected page and source record**. It does not establish legal or program eligibility, that the source system is current, that a caseworker selected the right person, or that every production site's business rules were interpreted correctly. Those remain human and pilot-validation responsibilities.

## Autonomous-run boundaries

The runner pauses instead of guessing when it encounters:

- a missing, ambiguous, conflicting, or stale source value;
- CAPTCHA, bot challenge, one-time code, login, or another direct-entry checkpoint;
- an unknown host, changed page signature, loop, unexpected navigation, or the 12-page safety ceiling;
- a control inside an unsupported cross-origin frame or closed shadow root;
- a mask or widget that rejects synthetic browser events; or
- certification, attestation, signature, final review, Finish, Complete, Apply, or Submit.

The caseworker does **not** need to reload the client on every page. The imported record remains in `chrome.storage.session` and the approved runner scans and fills each next page automatically. A full browser-session restart intentionally discards the values; the durable queue preserves the checkpoint and requires the source record to be reauthorized/reloaded before writes resume.

## Production validation still required

Before describing the product as production-ready, complete all of the following:

- Obtain a client-approved Apricot sandbox or test tenant and use synthetic records with production-representative schemas, field IDs, access controls, freshness, pagination, rate limits, and schema drift.
- Run a sanctioned BenefitsCal or agency-owned non-production application through every supported household composition and checkpoint, without creating a real submission.
- Add authenticated organization connections, server-side secret custody, tenant isolation, revocation, audit/retention controls, and mapping re-review on schema change.
- Test household-member repeaters, document uploads, address validation, dynamic conditional questions, account creation/login, save-and-return, renewals, case identifiers, and accessibility with assistive technology.
- Complete privacy, security, legal, accessibility, incident-response, and human-factors reviews.

## Decision

This build is suitable for a controlled, synthetic-data pilot and design/engineering review. It is **not yet suitable for unattended use with real applicants or production case-management credentials**.
