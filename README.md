# Nava Form-Filling Assistant — Chrome prototype

This is a loadable Manifest V3 Chrome extension that adapts Foad's `form-completion` skill to Jillian's side-panel design.

It is a working local prototype, not a production deployment. It can import a client or business document, inspect a visible web form, compare the fields with the reviewed record, ask one batch of missing questions, write the available values, read every changed field back, and show a provenance review. It has no submit command.

## What is implemented

- Jillian's main flow: find client → choose applications → dashboard → answer questions → review.
- Local document intake for PDF, DOCX, TXT, CSV, TSV, and JSON files up to 15 MB.
- Deterministic extraction of clearly labeled demographic, identity, contact, address, and business fields; no model or network call is used.
- Field-by-field intake review. New and matching values start selected; conflicts start unselected and require an explicit replacement choice.
- SSNs and EINs are masked in intake evidence and later review screens.
- One session-only client record shared across application tabs.
- One writer per tab. Each application is tracked independently.
- Live field inventory using labels, ARIA text, autocomplete, field types, required markers, options, masks, and maxlength.
- Gap categories from the skill: record values, changed values, missing values, decisions, and values with no place on the current page.
- Explicit no-inference rules for SSN, housing status, contact preference, household size, immigration status, income, childcare, and unemployment.
- Batched gap questions before the first write.
- Idempotent checkbox/radio writes, exact option matching, top-to-bottom writes, native value events, an incremental masked-field fallback, and readback verification.
- Diagnosis for hidden, disabled, masked, changed, and maxlength-constrained fields.
- Bundled knowledge signals for BenefitsCal, Riverside IHSS, and Riverside WIC.
- Submit-gate and bot-token inspection. The extension reports the state but cannot click submit.
- Session-only storage (`chrome.storage.session`). The raw uploaded document is not stored, and nothing is sent to a server by this build.
- A regular-page preview mode and a local form fixture for safe testing.

## Load it in Chrome

1. Open `chrome://extensions`.
2. Turn on **Developer mode**.
3. Choose **Load unpacked**.
4. Select this `nava-form-filler-extension` folder.
5. Open a web form and click the extension icon. Chrome opens the assistant in the side panel.

Chrome may require an already-open form tab to be refreshed once after the extension is first loaded.

## Safe local demo

From this folder, serve the fixture:

```bash
python3 -m http.server 4173 -d demo
```

Then open `http://localhost:4173/demo-form.html`, open the extension, and use demo client ID `339619`. The demo's submit button never sends anything.

To preview only the side-panel UI without loading the extension, serve the extension root and open:

```text
http://localhost:4173/sidepanel/index.html?preview=1
```

## Checks

```bash
npm run check
npm test
```

## Document intake behavior

Select **Upload a client or business document** from the first screen, or **Add document** beside an already loaded record. The extension parses the file on-device and shows each proposed value, confidence level, and a short source snippet before merging it.

PDF text extraction uses the bundled PDF.js worker. DOCX extraction reads the document XML with the bundled fflate archive library. Text and delimited files use the same strict labeled-field rules. See [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) for licenses.

Image-only or scanned PDFs are reported as unreadable because OCR is not included. Password-protected files, legacy `.doc` files, and arbitrary images are also outside this prototype.

## Production integration boundary

The current `ai-chatbot` source does not have a live Apricot lookup in the user flow; it passes bundled or pasted participant JSON to the agent. This prototype preserves that reality:

- `background.js` contains three fictional demo records.
- `LOOKUP_RECORD` is the narrow adapter point for a production Nava API.
- A production Apricot integration should call a Nava-controlled backend with the user's established organization session. Do not place Apricot client secrets in the extension.
- The managed build should narrow `host_permissions` to the approved application domains.

The browser extension also cannot produce genuinely trusted hardware keystrokes. Its incremental mask fallback works with many event-driven controls, but a site that rejects all synthetic events is marked for direct caseworker entry. Adding Chrome's debugger permission solely to force trusted keystrokes would create an invasive permission and is intentionally out of scope.

## Current limits

- It fills the visible page, then the caseworker moves to the next page and scans again. The extension does not automatically navigate an unknown form flow.
- It scans the top document, not cross-origin frames or closed shadow roots.
- Playbook signals identify known sites and known freshness fields; the live DOM scan remains authoritative for every write.
- Opening known applications is implemented. Background parallel autonomous agents are not: local Chrome tabs share a human browser and extension service worker, so this build enforces one writer per tab instead.
- There is no model call. Ambiguous, unlabeled fields become questions or remain untouched.

See [`docs/IMPLEMENTATION_NOTES.md`](docs/IMPLEMENTATION_NOTES.md) for the exact mapping from the six-phase skill to the extension architecture.
