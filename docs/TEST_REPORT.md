# Test report

Date: 2026-09-25

## Automated checks

Run from the repository root:

```bash
npm run check
npm test
```

The 161-test suite exercises the three-agent planner, shared Nava planner gateway, subscription companion, mapping, parsing, connector, queue, recovery, recertification scheduling/readiness/authorization, exact IHSS/WIC adapters, and BenefitsCal navigation logic; deterministically tests exclusive client sessions, per-application revisions and leases, sibling-safe partial persistence during an in-flight command, revoke/command ordering, tab closure, connector invalidation, versioned page-agent readiness, per-application progress, Codex token parsing, aggregate model metrics, directly analyzed known-site path policy, and the guarded BenefitsCal overview fallback. It also checks safety invariants around the no-submit boundary, bounded fill batches, document-bound messaging, allowlisted continuation, conditional rescans, semantic checkbox choices, repeated-entity abstention, OTP/CAPTCHA checkpoints, provider grouping/current routes, explicit recertification dates, session-only follow-up notes, client opt-in, and the passive 28-field fixture. A VM harness runs the real content-agent fill path and confirms that benign help text stays valid while a delayed 900 ms value reversion or asynchronous invalid state is blocked. The suite does not replace end-to-end live-site validation, real notification delivery, or real parallel-tab validation.

### Version 0.9.4 agentic, WIC-correctness, recovery, and human-checkpoint regression

- Chrome's on-device Gemini Nano Prompt API provides separate field-mapper, gap-analyst, and independent-review sessions.
- The model receives form metadata and available canonical purpose names, but not names, addresses, identifiers, income, or other participant values.
- Only mappings proposed by the mapper, approved by the reviewer, backed by an available source purpose, and accepted by the local validator reach the deterministic form engine.
- Page operations expose a WebMCP-style typed tool contract for inspect, reviewed fill, and safe continuation; no submit tool exists.

- Extension-state restoration retries background startup before showing an error.
- If an unpacked-extension reload invalidates the session-only client data, the banner tells the caseworker to close/reopen the side panel and reload the authorized source; durable application checkpoints remain intact.
- The side panel requires the current page-agent version and loaded site adapters, so a stale tab cannot silently run older mapping code.
- The complete observed WIC field inventory maps all fictional source-backed answers without false gaps in the adapter regression, while BenefitsCal stops after one unchanged overview attempt instead of reloading in a loop.
- Independent application cards retain their own run progress while concurrent tab-bound work is active.
- CAPTCHA and one-time-code cards offer an explicit resume action only after the caseworker completes the challenge. A fresh scan must show the challenge as complete before the runner continues.
- Challenge widgets and tokens are never clicked, populated, solved, or sent to a third party.
- A gap proposed from the pre-fill inventory is discarded when the same field has a reviewed source mapping, preventing a verified DOB or address from being asked for again.
- Single WIC checkboxes keep their real writable field key instead of a synthetic one-member group key; versioned RUHS purpose hints remain authoritative if the local mapper omits them.
- A source-backed checkbox is filled and verified. If RUHS checkbox answers are absent, related options are grouped into the site's two select-all-that-apply questions with an explicit **None of these** choice; other standalone checkboxes become Yes/No questions.
- Each plan returns value-free prompt count, context usage when Chrome exposes it, model duration, and `$0.00` on-device API cost; sanitized audit events retain only aggregate counters.

### Version 0.10.0 subscription companion regression

- A paired localhost provider can route the same three redacted planner roles through Codex CLI or Claude Code without placing provider credentials in Chrome.
- Provider selection and the pairing token use `chrome.storage.session`; only loopback HTTP endpoints are accepted.
- Companion requests are role-allowlisted, bearer-token protected, size/concurrency bounded, and schema constrained. Prompts are sent through stdin rather than command arguments.
- The Codex invocation is ephemeral, schema constrained, and read-only in an empty temporary directory. The Claude invocation uses safe mode, disables tools, disables Chrome integration, and disables session persistence.
- Provider API-key environment variables are removed; health checks require a subscription-authenticated CLI before the extension reports the runtime available.
- Unit coverage verifies that source values remain absent from all three companion request bodies and that token/duration/direct-API-cost accounting reaches the planner metadata.
- On 2026-09-25, the installed extension completed all three Codex roles twice on the live Riverside IHSS form. The bridge parsed Codex JSONL usage, totaling 104,510 input and 6,061 output tokens across six prompts and 127.9 seconds of model time; direct API-key cost remained `$0.00` because the signed-in ChatGPT subscription path was used.
- Claude Code is installed on the test machine but was signed out, so no live Claude subscription call is claimed.

### 2026-09-25 live synthetic-data model benchmark

| Runtime | Live site | Prompts | Model time | Usage | Verified writes | Visible-field coverage | Review-ready |
| --- | --- | ---: | ---: | --- | ---: | ---: | --- |
| Chrome Gemini Nano | Riverside County IHSS | 6 | 511.0 s | 35,877 context units | 32/35 (91.4%) | 32/44 (72.7%) | No |
| Codex subscription CLI | Riverside County IHSS | 6 | 127.9 s | 104,510 input / 6,061 output tokens | 34/37 (91.9%) | 34/44 (77.3%) | No |

Both live runs used fictional record `339619`, wrote values into the actual public IHSS form, and stopped before Section 9 affirmation, Cloudflare, and Submit. Codex correctly filled the applicant SSN and SSI/SSP answer that Gemini Nano left unresolved. Neither run was production-quality: applying for self, mailing-address equality, household IHSS status, and living arrangement remained unanswered, and the gap UI did not surface all of them.

A Codex run on the actual BenefitsCal flow verified the live language-preference page and reached the name-information route. It then exposed a path-policy defect specific to workflows started from an already-open known-site tab. Version 6 of the page agent now expands those tabs to the catalog's approved `/ApplyForBenefits/` path scope and adds a guarded fallback for the special overview BEGIN screen. The fix passes the automated suite and requires an installed-extension reload and live rerun before it is counted as end-to-end evidence. Raw value-free audit logs and the reproducible summary live in `evaluation/model-benchmark/`.

## Resumable queue and handoff walkthrough

Chrome ran the regular-page queue preview on 2026-09-15:

1. Loaded two interrupted applications: a paused BenefitsCal workflow and a WIC workflow assigned to the Intake team.
2. Selected **Verify and resume**. The assistant performed a fresh scan, matched the saved location and page signature, and moved the BenefitsCal workflow to ready-to-fill without writing first.
3. Accepted the WIC handoff. Its owner changed from pending assignment to active ownership and its checkpoint required another verified resume.
4. Paused the BenefitsCal workflow and assigned it to the fictional Eligibility team for supervisor review. The dashboard showed the pending owner and named checkpoint.
5. Simulated an expired browser session. The durable queue retained both workflows and progress, but the BenefitsCal card exposed only **Reload client data** rather than a fill or resume action.
6. The browser console reported no errors during the resume, accept, handoff, or recovery flows.

Unit tests additionally confirm that the durable payload contains no participant values, raw paths/query strings, or raw page signatures. Deterministic service-worker tests cover exclusive participant claims, stale session clears, per-application compare-and-swap revisions, lease ownership/release, command-versus-revoke ordering, tab closure, participant updates, and connector invalidation. A two-panel installed-browser concurrency exercise is still pending.

## OCR and extraction-quality gate

Run `npm run eval:extraction` to execute bundled Tesseract against six generated fictional fixtures: clean client data, a low-contrast/noisy scan, a rotated business record, a two-column business table, bilingual English/Spanish labels, and unsupported handwriting. The harness scores only proposals that survive the extension's actual confidence and safety filters.

| Metric | Result | Gate |
| --- | ---: | ---: |
| Field precision | 100.0% | ≥ 95.0% |
| Field recall | 91.2% | ≥ 80.0% |
| Expected-abstention accuracy | 100.0% | 100.0% |
| Accepted wrong values | 0 | 0 |
| Sensitive values exposed in evidence | 0 | 0 |

Three expected values were omitted rather than accepted incorrectly: two OCR email candidates that did not meet the 94% email floor and one noisy name containing a recognition artifact. The rotated fixture selected a 270° correction. The unsupported handwriting fixture yielded no field proposals. These are synthetic baseline results, not a claim about production-document accuracy; the full generated report is in `evaluation/latest-report.md` and its inspectable JSON companion.

## Chrome OCR walkthrough

Chrome loaded the regular-page preview with the bundled worker, WebAssembly core, and English model on 2026-09-15. No remote OCR service was configured.

1. A 1,200 × 1,500 PNG scan produced nine correct review proposals and withheld one suspect email candidate.
2. Every proposal included page number, OCR confidence, and a numeric source region; all nine checkboxes started unchecked.
3. After explicit selection, the nine values merged into the fictional client and the application-selection screen retained the document provenance.
4. The same raster image embedded as a one-page, image-only PDF used the PDF.js render-to-canvas path and then OCR. It produced eight correct proposals, withheld two candidates, and again left every proposal unchecked.
5. Neither run emitted a browser console warning or error.

## Self-service connector walkthrough

Chrome ran the regular-page side-panel preview's simulated connector UI on 2026-09-16. Preview mode did not contact the loopback service:

1. Opened **Connect a client data source**, confirmed the eight-provider catalog, and supplied the loopback service URL, opaque connection ID, form/resource key, organization label, and 30-day freshness window.
2. Loaded 28 labeled fields from Apricot form `99`; numeric IDs were normalized to explicit `field_###` source keys.
3. Confirmed 28 label/reference-tag suggestions in the mapping UI, including SSN, citizenship, and income destinations marked as sensitive.
4. Saved the read-only mapping. The client-choice screen reported the connected organization and mapped-field count.
5. Retrieved fictional record `339619`, reviewed all 28 mapped values with their source labels/IDs and freshness, and explicitly confirmed the import.
6. Reached program selection with the normalized Celeste record, organization provenance, and retrieval timestamp intact.

Separately, the mock service was probed directly for health, schema, and record responses. It returned 28 schema fields and 28 record values, binds only to `127.0.0.1`, rejects non-GET methods with HTTP 405, contains no credentials, and sends `Cache-Control: no-store`. These two checks validate the UI state machine and service contract independently; they do not constitute an installed-extension network walkthrough.

On 2026-09-17, the updated preview also confirmed that all eight provider cards are keyboard-reachable and open the provider-neutral setup form. Non-Apricot providers are labeled **Provisioned Nava adapter required** rather than pretending that an adapter ships in this repository. The header Home control returned from that setup screen immediately. A separate preview opened the OCR fixture, activated Home while OCR was still running, waited 4.5 seconds, and remained on Home after the OCR result completed; the cancelled operation did not replace the screen.

## Six-page extensive browser fixture

The fixture is now deliberately passive at `demo/extensive-application.html?step=1&reset=1`. It contains no participant record, form engine, page agent, or URL-triggered autofill routine. Any automated scan, fill, verification, or advance shown on it must come from the installed extension. Presentation mode scrolls to and highlights each field long enough to make individual writes visible, then waits for page-level validation before continuation. This is demo pacing, not a production-duration estimate.

A Chrome regression check also opened the fixture with the obsolete `autorun=1` query, waited 2.2 seconds, and confirmed that all five page-one controls remained empty. That check demonstrates that the page cannot manufacture the prior instant-completion result.

| Page | Engine-covered fields | Fixture guard |
| --- | --- | --- |
| Applicant identity | 5 of 5 mappings tested | Exact **Next** is an allowlisted fixture control |
| Contact and address | 9 of 9 mappings tested | Exact **Save and continue** is allowlisted |
| Demographics | 7 of 7 mappings tested | Exact **Continue** is allowlisted |
| Household | 4 of 4 mappings tested | Exact **Next** is allowlisted |
| Income and expenses | 3 of 3 mappings tested | Exact **Continue** is allowlisted |
| Review and submit | 28-field summary is rendered from page storage | Certification and submission remain human-only |

On 2026-09-23, the installed extension with Chrome's downloaded on-device model advanced the passive fixture from Step 1 through Step 6. The final page reported `28 of 28 fixture fields recorded across 5 of 5 data-entry pages`; its page history reported `5/5`, `9/9`, `7/7`, `4/4`, and `3/3`. The certification checkbox remained unchecked, **Submit application** was not activated, and the page emitted no warnings or errors. This replaces the earlier fixture-local `autorun=1` evidence. Parallel background-tab validation is still pending.

## Three-page browser fixture

The passive three-page fixture is available at `demo/multi-page.html?step=1`. Static safety tests confirm its exact safe continuation controls and final submit guard, and confirm it contains no embedded page agent or participant record.

| Page | Expected extension writes | Fixture guard |
| --- | --- | --- |
| About the applicant | 4 mapped controls | Exact **Next** is allowlisted |
| Home address | 5 mapped controls | Exact **Save and continue** is allowlisted |
| Review and submit | 3 mapped controls | Submit and certification are never allowlisted |

The side-panel preview independently exercises the three-page state machine, retains one client record across pages, archives per-page provenance, and stops at final review. It is a UI/state-machine preview, not evidence about a live government form.

## Live BenefitsCal compatibility check

BenefitsCal is an appropriate real-world target: the official portal supports applications for CalFresh, CalWORKs, Medi-Cal, and other California assistance programs. CDSS also directs applicants to BenefitsCal for online benefits applications.

Read-only Chrome checks on 2026-09-17:

1. Opened `https://benefitscal.com/` and selected **APPLY FOR BENEFITS**.
2. Opened the public “Ready to do this? Here's how it works” page and selected **BEGIN**.
3. Inspected the public **Helpful Tips** page. It displays an exact **Next** button and tells applicants that clicking Next saves their information.
4. Followed that public navigation to the **Diversity, Equity, and Inclusion Statement**, which again exposes an exact **Next** button.
5. Continued through the public Statement of Non-Discrimination and navigation summary, where the site exposes **Start Your Information**, then reached language preferences.
6. Loaded the current Riverside IHSS intake route at `https://riversideihss.org/IntakeApp`; the old `/Home/IHSS` route returned an error.
7. Loaded the Riverside WIC form and confirmed that its `www`/apex redirect pair must both be approved.
8. Stopped without entering participant data, accepting an attestation, solving a CAPTCHA, creating an account, or submitting an application.

Observed BenefitsCal checkpoint URL: `https://benefitscal.com/ApplyForBenefits/ABLPR`

This confirms current public routes and the **Begin**, **Next**, and route-specific **Start Your Information** transitions used by the playbook. Some BenefitsCal transitions took roughly 12–15 seconds, so the runner now allows up to 60 seconds for a stable next page. It is not a claim that any live applicant question was filled correctly; that requires a sanctioned test environment and non-production account/data.

References:

- [BenefitsCal](https://benefitscal.com/)
- [BenefitsCal program overview](https://info.benefitscal.com/)
- [California Department of Social Services FAQ](https://www.cdss.ca.gov/about-cdss/frequently-asked-questions)

## Safety result

The extension can automate page-to-page continuation without automating legal assent or submission. It advances only when all of these conditions are true:

- the host has an approved playbook (or the page is the explicit local test fixture);
- the visible, enabled control's normalized label exactly matches the safe allowlist;
- no CAPTCHA or equivalent human check is incomplete;
- no final-review, certification, attestation, signature, or submit signal is present; and
- the page signature has not already been visited and the run remains below its playbook-specific limit, which is capped at 60 pages.
