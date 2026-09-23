# Nava Form-Filling Assistant — Chrome prototype

This is a loadable Manifest V3 Chrome extension that adapts Foad's `form-completion` skill to Jillian's side-panel design.

It is a working local prototype, not a production deployment. It implements flows for a read-only organization data service, labeled source mapping, client or business document import, application inspection, missing-answer collection, approved multi-page filling, readback verification, and provenance review. It has no submit command.

> **Evidence boundary:** the field-mapping engine has 28-of-28 synthetic source-field coverage, and the extension code path for the local fixtures uses the real scan/fill/navigation messages. The fixtures contain no client record and no embedded autofill runner. A fresh installed-extension end-to-end run is still required after loading this version. This build has not been connected to a production Apricot tenant or completed a live BenefitsCal, IHSS, or WIC application in a sanctioned test environment. Use only fictional or approved test data. See [production-readiness evidence](docs/PRODUCTION_READINESS.md).

## Architecture disclosure: this build does not use an LLM

The current form-filling controller is deterministic browser automation, not an LLM-based agent. `shared/form-engine.js` maps known field labels to reviewed source values, `shared/site-adapters.js` supplies exact site rules, and `content/form-agent.js` performs bounded DOM scan/write/readback operations. Tesseract's bundled English model is used only for on-device OCR. No prompt, inference request, hosted language model, or model-selected browser action exists in this version.

This makes the repository a browser execution and safety prototype for the form-completion protocol; it does **not** yet test the LLM planner used by an agentic production form filler. Adding that planner requires an explicit model-service boundary, organization authorization, data-minimization and retention controls, schema-constrained actions, local policy validation, and evaluation against sanctioned non-production benefit flows. The deterministic executor and final-submit boundary should remain enforcement layers beneath any future model.

## What is implemented

- Jillian's main flow: find client → choose applications → dashboard → answer questions → review.
- Local document intake for PDF, PNG, JPEG, WebP, DOCX, TXT, CSV, TSV, and JSON files up to 15 MB.
- Deterministic extraction of clearly labeled demographic, identity, contact, address, and business fields, plus bounded on-device English OCR for images and image-only PDF pages. No model or network call is used.
- Page, region, OCR-confidence, and rotation provenance for every OCR proposal. OCR values always start unchecked and require explicit review before import.
- A reproducible synthetic extraction corpus covering clean scans, low contrast, rotation, tables, bilingual labels, and unsupported handwriting. The current quality gate passes at 100% precision, 91.2% recall, 100% expected-abstention accuracy, zero accepted wrong values, and zero sensitive evidence leaks.
- Field-by-field intake review. New and matching values start selected; conflicts start unselected and require an explicit replacement choice.
- SSNs and EINs are masked in intake evidence and later review screens.
- A provider-neutral managed-connector flow: searchable source catalog, health check, labeled-schema discovery, suggested mappings, admin review, record lookup, field-level provenance, stale-record warnings, and caseworker confirmation before import. The included runnable adapter is a fictional Apricot-shaped loopback fixture; other catalog entries require production server adapters.
- A hard credential boundary. Chrome accepts only an organization label, HTTPS service URL, opaque connection ID, form ID, reviewed mappings, and freshness policy. Provider secrets stay server-side.
- One session-only client record shared across application tabs.
- One writer per tab. Each application is tracked independently.
- Selecting several known applications opens their tabs and immediately starts up to three independent runs. CalFresh, Medi-Cal, and CalWORKs are grouped into one BenefitsCal workflow because BenefitsCal collects those program selections in a single application.
- Guided multi-page completion for approved site playbooks. The runner keeps the client record loaded, fills each page, reads every write back, and activates only exact safe continuation labels such as **Begin**, **Next**, or **Save and continue**.
- Exact live-DOM adapters for Riverside IHSS and Riverside WIC. They distinguish applicant, representative, household, facility, and mailing scopes; preserve semantic Yes/No and sex choices even when the page exposes ambiguous checkbox values; and stop unsupported conditional fields as caseworker questions instead of borrowing applicant data. The fictional IHSS record includes a separately sourced household member, so household rows never inherit the applicant's identity.
- Bounded same-page rescans after every verified fill pass so conditionally revealed fields are handled before the runner considers a safe continuation control.
- Cross-page progress history, loop detection, playbook-specific page limits capped at 60, and automatic pauses when a field needs direct help.
- A durable multi-application work queue with stable workflow IDs, explicit checkpoints, tab-closure recovery, and restart-safe progress metadata.
- Verified resume: the assistant rescans the live tab and compares its URL and page signature before it permits another write.
- Human-checkpoint resume for reCAPTCHA, hCaptcha, Cloudflare Turnstile, and one-time-code screens. The assistant pauses without interacting with the challenge; after the caseworker completes it, **I completed the CAPTCHA — resume** performs a fresh scan and continues the approved run.
- Caseworker/team ownership, pending and accepted handoffs, and a service-worker-coordinated per-application lease designed to prevent two assistant windows from writing to the same workflow at once. A two-panel Chrome validation is still pending.
- A value-free activity log for scan, fill, verification, safe navigation, pause, resume, handoff, review, and tab-closure events. Caseworkers can export it as JSON.
- A hard final-action boundary: certification, attestation, signature, Finish, Complete, Apply, and Submit controls are never activated.
- Live field inventory using labels, ARIA text, autocomplete, field types, required markers, options, masks, and maxlength.
- Gap categories from the skill: record values, changed values, missing values, decisions, and values with no place on the current page.
- Explicit no-inference rules for SSN, housing status, contact preference, household size, immigration status, income, childcare, and unemployment.
- Batched gap questions before the first write.
- Idempotent checkbox/radio writes, exact option matching, top-to-bottom writes, native value events, an incremental masked-field fallback, and readback verification.
- Diagnosis for hidden, disabled, masked, changed, and maxlength-constrained fields.
- Bundled knowledge signals for BenefitsCal, Riverside IHSS, and Riverside WIC.
- Submit-gate and bot-token inspection. The extension reports the state but cannot click submit.
- Session-only participant storage (`chrome.storage.session`). The raw uploaded document is not stored. Non-personal connector configuration and labeled schema use `chrome.storage.local`; managed lookups use the configured organization service.
- A regular-page preview mode and a local form fixture for safe testing.

## Load it in Chrome

1. Open `chrome://extensions`.
2. Turn on **Developer mode**.
3. Choose **Load unpacked**.
4. Select this `nava-form-filling-assistant-chrome-extension` folder.
5. Open a web form and click the extension icon. Chrome opens the assistant in the side panel.

Chrome may require an already-open form tab to be refreshed once after the extension is first loaded.

Reloading the unpacked extension intentionally invalidates the in-memory client session. Close and reopen the side panel, then reload the authorized client record; durable application checkpoints remain available. Version 0.9.2 retries background startup before showing this recovery guidance instead of reporting a generic restoration failure and rejects stale page-agent code after an extension reload.

## Safe local demo

From this folder, serve the project:

```bash
python3 -m http.server 4173
```

Then open `http://localhost:4173/demo/demo-form.html`, open the extension, and use demo client ID `339619`. The demo's submit button never sends anything.

These pages contain no self-fill logic. Any automated scanning, typing, verification, or navigation shown in a demo must originate from the installed extension. On the trusted localhost multi-page fixtures, presentation mode highlights and scrolls each field long enough to make individual writes visible, then waits for page-level validation before continuation. This is demo pacing, not a production-duration estimate.

The passive three-page DOM fixture is available at:

```text
http://localhost:4173/demo/multi-page.html?step=1
```

The extensive six-page, 28-field validation flow runs at:

```text
http://localhost:4173/demo/extensive-application.html?step=1&reset=1
```

To preview only the side-panel UI without loading the extension, serve the extension root and open:

```text
http://localhost:4173/sidepanel/index.html?preview=1&demo=1
```

## Self-service connector demo

The repository includes a provider-neutral extension contract and a loopback-only connector service with fictional Apricot-shaped data. It never accepts provider credentials. The catalog also names Salesforce Nonprofit, Bitfocus Clarity, WellSky Community Services, Eccovia ClientTrack, CaseWorthy, Foothold AWARDS, and Bonterra ETO, but those entries require authorized server adapters before they can connect.

```bash
npm run connector:mock
```

In the extension, choose **Connect an organization database**, select **Bonterra Apricot 360**, then configure:

```text
Organization: Riverside Community Services
Service URL: http://127.0.0.1:4789
Connection ID: nava-demo
Provider: Bonterra Apricot 360
Form / resource key: 99
```

Test the connection, review the label-based mapping, save it, retrieve fictional record `339619`, and confirm the mapped record preview. For a regular-page UI walkthrough, open `http://localhost:4173/sidepanel/index.html?preview=1`; **Use local demo settings** supplies those values.

The production service contract and required security controls are documented in [`connector-service/README.md`](connector-service/README.md). The [connector coverage matrix](docs/CONNECTOR_COVERAGE.md) explains why this is not yet a Plaid-like production network.

## Checks

```bash
npm run check
npm test
npm run eval:extraction
```

## Document intake behavior

Select **Upload a client or business document** from the first screen, or **Add document** beside an already loaded record. The extension parses the file on-device and shows each proposed value, confidence level, and a short source snippet before merging it.

PDF text extraction uses the bundled PDF.js worker. Pages without usable embedded text, as well as PNG, JPEG, and WebP images, use the bundled Tesseract.js runtime and pinned English `tessdata_fast` model. DOCX extraction reads the document XML with bundled fflate. Text and delimited files use the same strict labeled-field rules. Nothing is sent to an OCR service.

OCR is capped at 8 pages, 8 million pixels per attempt, 32 million total processed pixels, 10 attempts, a 30-second startup timeout, and 45 seconds per page. It retries 90°/270° rotation only for weak first passes. Candidates below the base 70% confidence floor are withheld; email and sensitive identifiers require stricter confidence, and common name artifacts are rejected. Every accepted OCR proposal still starts unchecked. Password-protected files, HEIC, legacy `.doc`, handwriting extraction, and languages other than English are outside this build.

Run `npm run eval:extraction` to reproduce the published [quality report](evaluation/latest-report.md). See [OCR security and limits](docs/OCR_SECURITY_AND_LIMITS.md) for the threat model, resource budgets, abstention policy, and pilot work still required. See [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) for licenses.

## Resumable work queues and handoff

Version 0.9.2 retains the privacy boundary between short-lived client values and durable operational state:

- Participant values, document proposals, raw page signatures, and full page URLs remain in `chrome.storage.session` and expire with the browser session.
- `chrome.storage.local` retains only sanitized queue metadata: workflow/program IDs, application label, approved origin and catalog route prefixes, status, progress counts, checkpoint, owner/handoff state, tab ID, timestamps, and opaque checksums of the saved location and page signature.
- Closing a tab creates a recoverable checkpoint. Restarting Chrome preserves the queue, but the assistant requires the caseworker to reload the authorized source record before resuming because participant values were intentionally not retained.
- Resume always performs a read-only live scan first. A changed location, changed page signature, stale source, expired source, unaccepted handoff, or missing tab blocks writes.
- CAPTCHA, one-time codes, direct-entry fields, certification, signature, and final review are named checkpoints rather than background automation steps. CAPTCHA and one-time-code checkpoints expose an explicit human-complete-and-resume action; the extension never attempts to solve or bypass the challenge.

The current handoff is a same-Chrome-profile workflow and ownership prototype. It does not transmit client data or synchronize queues between caseworkers. A production cross-device handoff requires an authenticated organization service with authorization, encrypted storage, retention controls, and concurrency enforcement. See [work-queue security and recovery](docs/WORK_QUEUE_SECURITY_AND_RECOVERY.md).

## Production integration boundary

Version 0.9 implements the extension half of a provider-neutral managed connector, bounded local OCR, an extraction-quality gate, passive synthetic benefits fixtures, exact adapters for the currently observed Riverside IHSS and WIC DOMs, safer BenefitsCal navigation rules, and a resumable metadata-only work queue. It ships a fictional loopback connector service for contract testing, not a production credential broker, organization-authentication service, provider network, or cross-device queue backend.

- `background.js` uses credentialed, read-only `GET` requests to the configured Nava connector service. It does not call Apricot directly.
- `shared/connector-engine.js` accepts only labeled schema fields, rejects secret-like configuration, requires HTTPS outside localhost, and will not infer meaning from an opaque source field ID.
- Chrome stores the sanitized connection descriptor, reviewed mapping, and labeled schema—not Apricot credentials or participant records. Retrieved participant data remains session-only.
- The production service must authenticate the current organization, keep provider credentials in a secret manager, enforce least-privilege read scopes, restrict CORS to the managed extension ID, support revocation, and avoid logging record bodies.
- The managed build should narrow `host_permissions` to approved application and connector domains.

The browser extension also cannot produce genuinely trusted hardware keystrokes. Its incremental mask fallback works with many event-driven controls, but a site that rejects all synthetic events is marked for direct caseworker entry. Adding Chrome's debugger permission solely to force trusted keystrokes would create an invasive permission and is intentionally out of scope.

## Current limits

- Automatic continuation is deliberately allowlisted. Unknown sites and ambiguous controls pause for the caseworker instead of navigating.
- Human checkpoints—including CAPTCHA, one-time codes, certifications, signatures, and the final submission—always pause the run.
- It scans the top document, not cross-origin frames or closed shadow roots.
- Playbook signals identify known sites and known freshness fields; the live DOM scan remains authoritative for every write.
- Known applications start automatically after their tabs open, with up to three tab-bound runs in parallel. The side panel must stay open during an active run; moving runner execution into a durable service-worker or authenticated server job is still required for close-the-panel-and-return-later operation.
- A run fills every known value before pausing for unanswered required fields. Repeated person or income fields fail closed unless an exact adapter proves their entity scope; strict scalar confirmation pairs such as email/confirm-email remain supported. The bundled fictional record now contains explicit synthetic IHSS and WIC decisions for adapter testing; CAPTCHA, unsupported conditional entities, affirmation, certification, and final submission still require a person. Installed-extension validation on those live flows remains required before claiming production compatibility.
- Live validation in this repository is limited to route and public-page compatibility. There has been no sanctioned, end-to-end production application run and no real applicant data should be entered for testing.
- Handoff metadata is local to one Chrome profile. It demonstrates the ownership and acceptance flow but is not an authenticated cross-device assignment system.
- The included connector server is a fictional loopback fixture. A real organization still needs the Nava-controlled service, provider partnership/access, authentication, security review, and data-processing controls.
- Provider selection is not the same as a live connection. Only the fictional Apricot-shaped adapter is runnable in this repository; all other listed systems require authorized backend adapters and sandbox validation.
- There is no model call. Ambiguous, unlabeled, low-confidence, and unsupported OCR content is withheld or remains untouched.

## Evidence, costs, and next steps

- [Production-readiness evidence](docs/PRODUCTION_READINESS.md) states exactly what is and is not validated.
- [Connector coverage](docs/CONNECTOR_COVERAGE.md) covers the current catalog, major human-services systems, and the work needed for a Plaid-like experience.
- [Application cost model](docs/COST_MODEL.md) separates the prototype's $0 marginal third-party usage cost from a realistic production calculation.

See [`docs/IMPLEMENTATION_NOTES.md`](docs/IMPLEMENTATION_NOTES.md) for the exact mapping from the six-phase skill to the extension architecture.

See [`docs/TEST_REPORT.md`](docs/TEST_REPORT.md) for the connector walkthrough, controlled multi-page results, and read-only BenefitsCal compatibility check. The updated next product investment is in [`docs/ROADMAP.md`](docs/ROADMAP.md).
