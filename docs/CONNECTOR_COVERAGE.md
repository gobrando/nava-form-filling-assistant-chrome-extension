# Self-service connector coverage

Date: 2026-09-16

## Current product boundary

The extension now presents a provider-neutral catalog, a consistent managed-service contract, labeled-schema discovery, suggested mappings, explicit mapping review, record lookup, freshness/provenance display, and confirmation before import.

It is **not yet a Plaid-like production network**. The catalog does not make a provider live by itself. Every organization still needs an authorized Nava-managed server adapter, provider credentials or OAuth grant, tenant-specific mapping approval, and security/compliance review. The repository contains one fictional loopback adapter shaped like Apricot and no production credentials.

## Catalog and adapter status

| Provider | Typical use | Extension catalog/contract | Runnable adapter in this repo | Production validation |
| --- | --- | ---: | ---: | ---: |
| Bonterra Apricot 360 | Nonprofit case management | Yes | Fictional loopback | Not done |
| Salesforce / Agentforce Nonprofit | CRM and case management | Yes | Adapter required | Not done |
| Bitfocus Clarity Human Services | HMIS | Yes | Adapter required | Not done |
| WellSky Community Services / ServicePoint | HMIS | Yes | Adapter required | Not done |
| Eccovia ClientTrack | HMIS and case management | Yes | Adapter required | Not done |
| CaseWorthy | HMIS and case management | Yes | Adapter required | Not done |
| Foothold AWARDS | Human services and EHR | Yes | Adapter required | Not done |
| Bonterra ETO | Impact and case management | Yes | Adapter required | Not done |

This list is grounded in provider-published integration material for [Apricot](https://www.bonterratech.com/product/apricot), [Salesforce Nonprofit Cloud](https://resources.docs.salesforce.com/latest/latest/en-us/sfdc/pdf/nonprofit_cloud.pdf), [Bitfocus Clarity](https://help.bitfocus.com/operational-api-early-access), [Eccovia ClientTrack](https://help.eccovia.com/en_US/integrations/guide-for-clienttrack-integration-tools), [CaseWorthy](https://caseworthy.com/articles/unlock-seamless-integrations-and-unmatched-flexibility-with-the-caseworthy-form-api/), [WellSky Community Services](https://info.wellsky.com/rs/596-FKF-634/images/WellSky_Community_Services_UI_FAQ_20230721.pdf), [Foothold AWARDS](https://footholdtechnology.com/wp-content/uploads/2022/12/FHIR-API-Terms-of-Use-12092022.pdf), and [Bonterra ETO](https://www.bonterratech.com/sites/default/files/2023-08/eto-caiq-lite-june-2020.pdf).

It also covers the largest vendors named in HUD's published HMIS APR vendor summary: WellSky ServicePoint (42%), Bitfocus Clarity (26%), ClientTrack (12%), CaseWorthy (6%), and Foothold AWARDS (6%). Social Solutions ETO/Apricot represented another 2% in that summary. These shares are useful prioritization evidence, not a current certification list; [HUD explicitly does not maintain an official certified-vendor list](https://files.hudexchange.info/course-content/implementing-effective-contract-negotiation-and-relationship-management-strategies-101/Implementing-Effective-Contract-Negotiation-and-Relationship-Management-Strategies-101-Transcript.pdf). See the [HUD HMIS APR summary](https://files.hudexchange.info/resources/documents/HMIS-APR-Summary-Report.pdf).

## What a Plaid-like experience still requires

A production provider picker needs a backend control plane that is deliberately absent from the extension:

1. Organization login and tenant authorization.
2. Provider discovery filtered by the organization's licensed systems and region.
3. OAuth or administrator-mediated credential setup, with secrets held in a managed secret store rather than Chrome.
4. Provider-specific adapters that normalize labeled schemas and records into the canonical Nava contract.
5. Connection health, scope inspection, revocation, credential rotation, retry/backoff, and rate-limit handling.
6. Mapping-drift detection and required human reapproval when source labels or types change.
7. Value-free audit events, retention controls, cross-tenant isolation tests, incident response, and provider partnership/contract review.
8. Provider sandboxes and certification tests for supported versions and endpoints.

Only after those capabilities and at least one live authorized adapter exist should the UI promise that a user can simply search for a provider and connect.

## Why the extension uses a managed connector

Provider secrets and refresh tokens must never be stored in extension code or browser storage. Chrome retains only a sanitized descriptor (organization label, service URL, opaque connection ID, provider/source key, reviewed mappings, and freshness policy). The Nava service performs credentialed read-only retrieval and returns labeled source fields plus provenance. Participant values remain browser-session-only.

CSV, JSON, PDF, image, Word, text, and tabular document intake remains available as an explicit, reviewed fallback for organizations that can export records but do not yet have a managed adapter.
