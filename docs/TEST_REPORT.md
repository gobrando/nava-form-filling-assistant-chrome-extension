# Test report

Date: 2026-09-16

## Automated checks

Run from the repository root:

```bash
npm run check
npm test
```

The 49-test suite covers canonical client and business records, field mapping and formatting, masked-value verification, document and OCR extraction, OCR resource budgets and default-review behavior, bundled-parser and storage boundaries, provider-neutral connector configuration, labeled-schema mapping, source provenance/freshness, Manifest V3 configuration, and the no-submit contract. It also verifies the connector's read-only boundary, the multi-page runner's allowlisted continuation, OTP/CAPTCHA checkpoints, restart recovery, tab closure, changed-page rejection, stale/expired sources, pending handoffs, competing leases, durable metadata sanitization, value-free audit export, the provider catalog, and a 28-field extensive benefits flow.

## Resumable queue and handoff walkthrough

Chrome ran the regular-page queue preview on 2026-09-15:

1. Loaded two interrupted applications: a paused BenefitsCal workflow and a WIC workflow assigned to the Intake team.
2. Selected **Verify and resume**. The assistant performed a fresh scan, matched the saved location and page signature, and moved the BenefitsCal workflow to ready-to-fill without writing first.
3. Accepted the WIC handoff. Its owner changed from pending assignment to active ownership and its checkpoint required another verified resume.
4. Paused the BenefitsCal workflow and assigned it to the fictional Eligibility team for supervisor review. The dashboard showed the pending owner and named checkpoint.
5. Simulated an expired browser session. The durable queue retained both workflows and progress, but the BenefitsCal card exposed only **Reload client data** rather than a fill or resume action.
6. The browser console reported no errors during the resume, accept, handoff, or recovery flows.

Unit tests additionally confirm that the durable payload contains no participant values, raw paths/query strings, or raw page signatures; an active lease blocks a second assistant panel; and expired leases can be safely reclaimed.

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

Chrome ran the regular-page side-panel preview against the fictional Apricot-shaped connector fixture on 2026-09-16:

1. Opened **Connect a client data source**, confirmed the eight-provider catalog, and supplied the loopback service URL, opaque connection ID, form/resource key, organization label, and 30-day freshness window.
2. Loaded 28 labeled fields from Apricot form `99`; numeric IDs were normalized to explicit `field_###` source keys.
3. Confirmed 28 label/reference-tag suggestions in the mapping UI, including SSN, citizenship, and income destinations marked as sensitive.
4. Saved the read-only mapping. The client-choice screen reported the connected organization and mapped-field count.
5. Retrieved fictional record `339619`, reviewed all 28 mapped values with their source labels/IDs and freshness, and explicitly confirmed the import.
6. Reached program selection with the normalized Celeste record, organization provenance, and retrieval timestamp intact.

The mock service was also probed directly for health, schema, and record responses. It returned 28 schema fields and 28 record values, binds only to `127.0.0.1`, rejects non-GET methods with HTTP 405, contains no credentials, and sends `Cache-Control: no-store`.

## Six-page extensive browser fixture

Chrome ran `demo/extensive-application.html?step=1&autorun=1&reset=1` with the fictional Celeste record. It autonomously advanced across five data-entry pages, retained the record without reloading, and stopped at page six for human review.

| Page | Result | Continuation decision |
| --- | --- | --- |
| Applicant identity | 5 of 5 completed | Exact **Next** activated |
| Contact and address | 9 of 9 completed | Exact **Save and continue** activated |
| Demographics | 7 of 7 completed | Exact **Continue** activated |
| Household | 4 of 4 completed | Exact **Next** activated |
| Income and expenses | 3 of 3 completed | Exact **Continue** activated |
| Review and submit | 28-field completion summary present | Stopped at final review |

The run exposed and fixed a real classification defect caused by a `<select>` label concatenating its option text with “Gender.” A regression test now covers the corrected classification. The certification checkbox remained unchecked and **Submit application** was not activated.

## Three-page browser fixture

Chrome ran `demo/multi-page.html?step=1&autorun=1` with fictional Nava test record `339619` (Celeste NAVA Thomas II).

| Page | Result | Continuation decision |
| --- | --- | --- |
| About the applicant | 4 of 4 writes verified | Exact **Next** activated |
| Home address | 5 of 5 writes verified | Exact **Save and continue** activated |
| Review and submit | 3 of 3 writes verified | Stopped at final review |

The certification checkbox remained a human-only control. The fixture's **Submit application** button was visible, but the page agent returned `final_review` and did not activate it.

The side-panel preview independently completed the same three-page flow, retained one client record across all pages, archived per-page provenance, and produced one final review containing 12 verified values.

## Live BenefitsCal compatibility check

BenefitsCal is an appropriate real-world target: the official portal supports applications for CalFresh, CalWORKs, Medi-Cal, and other California assistance programs. CDSS also directs applicants to BenefitsCal for online benefits applications.

Read-only Chrome check on 2026-09-14:

1. Opened `https://benefitscal.com/` and selected **APPLY FOR BENEFITS**.
2. Opened the public “Ready to do this? Here's how it works” page and selected **BEGIN**.
3. Inspected the public **Helpful Tips** page. It displays an exact **Next** button and tells applicants that clicking Next saves their information.
4. Followed that public navigation to the **Diversity, Equity, and Inclusion Statement**, which again exposes an exact **Next** button.
5. Stopped without entering participant data, accepting an attestation, creating an account, or submitting an application.

Observed checkpoint URL: `https://benefitscal.com/ApplyForBenefits/ABDEI`

This confirms the live host, the current public application landing route (`/ApplyForBenefits/begin/ABOVR`), and the exact **Begin**/**Next** labels used by the BenefitsCal playbook. It is not a claim that every current BenefitsCal question was filled in production; that requires a sanctioned test environment and non-production account/data.

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
- the page signature has not already been visited and the run remains below 12 pages.
