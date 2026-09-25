# Recertification status and preparation

Version 0.11.0 adds a caseload-level recertification workflow to the extension. It is an operational prototype: the schedule and client record come from an authorized organization connector, while follow-up answers and authorization remain in `chrome.storage.session` for the current browser session.

## Caseworker flow

1. Open **Recertification status** from the assistant home or application dashboard.
2. Review the caseload sorted by overdue, urgent, due soon, and upcoming recertifications.
3. Open a client to see the caseworker alert and a client-message draft.
4. Create an outreach task and, after using an approved organizational channel, mark the client contacted.
5. Proactively review contact/address, household changes, income/employment, expenses/deductions, and supporting documents with the client.
6. Record the client’s explicit answer to: “Would you like the AI assistant to prepare your recertification through the review page?”
7. **Prepare with AI** unlocks only when all five information areas are current or confirmed and the client has authorized preparation.
8. The source record is loaded, the appropriate known application opens, and the existing agentic runner begins. It still stops before certification, signature, or submission.

Declining or not answering never starts an application. Authorization scope is `prepare_through_review`; it is not authorization to sign, attest, certify, or submit.

## Connector contract

The extension performs a read-only request:

```text
GET /v1/connectors/{connectionId}/recertifications?sourceId={sourceId}
```

The service returns an array under `cases` (or `items`):

```json
{
  "ok": true,
  "cases": [
    {
      "id": "opaque-recertification-id",
      "recordId": "opaque-source-record-id",
      "displayName": "Client display name",
      "firstName": "Client first name",
      "programId": "calfresh",
      "programName": "CalFresh",
      "dueDate": "2026-10-06",
      "preferredContact": "Email",
      "requirements": {
        "contact": { "status": "current" },
        "household": { "status": "missing" },
        "income": { "status": "stale" },
        "expenses": { "status": "missing" },
        "documents": { "status": "missing" }
      }
    }
  ]
}
```

`dueDate` must be an explicit ISO date from the authoritative source. The extension does not estimate recertification dates from enrollment dates or program history. Invalid and incomplete items are rejected locally. Supported source states are `current`, `confirmed`, `missing`, and `stale`.

The bundled connector and default extension mode return fictional, rolling-due-date fixtures for records `339619`, `338618`, and `339637`. They are for UI and workflow testing only.

## Notification boundary

The caseworker is notified in the recertification dashboard. The extension creates client outreach tasks and message previews, but it does not claim that email or SMS was delivered. A caseworker must send the message through an approved channel and explicitly mark outreach complete.

Production delivery requires an authenticated organization messaging service with client communication preferences, consent rules, delivery receipts, retry handling, opt-out enforcement, template/version audit, and role-based access. Those capabilities are intentionally not simulated by the Chrome extension.

## Privacy and operational state

- Caseload names, source record IDs, follow-up notes, outreach status, and authorization remain session-only in Chrome.
- The durable application queue receives workflow metadata only after an authorized application has started.
- Raw answers are not added to the exported activity log.
- Connector credentials remain server-side; the extension continues to hold only an opaque connection ID and reviewed mapping configuration.
- This prototype can monitor the whole caseload, but the current assistant safety model still permits one active client identity per browser session. A caseworker must finish or end that client session before preparing another client’s recertification.

## Production follow-ups

- Persist due dates, outreach delivery, client answers, and authorization in an authenticated case-management service with retention and access controls.
- Add scheduled server-side due-date evaluation instead of relying on the dashboard being opened.
- Integrate approved SMS/email/portal delivery and inbound client responses.
- Define program- and jurisdiction-specific recertification evidence requirements rather than relying on the common five-area checklist.
- Add revocation and expiration rules for client authorization.
- Validate every supported recertification route in sanctioned test environments.
