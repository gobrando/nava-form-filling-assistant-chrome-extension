# Application cost model

Date: 2026-09-23

## Current prototype

The repository's current marginal model/API usage cost is **$0 per application**:

- form classification, filling, verification, queueing, and handoff logic run locally in Chrome;
- three Gemini Nano planning roles run through Chrome's on-device Prompt API, with no per-token API charge;
- PDF/image OCR runs on-device with bundled open-source assets;
- there is no hosted model/API call in the fill loop; and
- the included connector is a local fictional fixture.

That number excludes caseworker time, engineering, support, security/compliance work, and the user's computer/network. It is not a production quote.

The $0 model/API figure does not mean there is no inference or resource consumption: Gemini Nano runs locally on the user's device. A pilot must measure model availability, one-time download size, prompt latency, retries, battery/CPU/memory impact, electricity, and exception-handling time.

Version 0.9.4 displays value-free usage on each application card and includes model runtime, prompt count, model duration, and API cost in the sanitized activity log. Chrome context-usage units are shown when the runtime exposes them. These counters were not present for runs made before 0.9.4, so old sessions cannot be reconstructed exactly; their on-device model API charge was still `$0.00`.

The current extension has no hosted model call. A future authenticated Nava/Foad gateway may route the same schema-constrained roles to Claude or another approved cloud model. That path must return provider token usage and calculated cost, keep provider keys out of Chrome, and remain subject to the same local validator. See [model providers and usage accounting](MODEL_PROVIDERS.md).

## Production formula

For an authenticated deployment, calculate:

```text
cost per completed application =
  (monthly connector/control-plane infrastructure
   + identity
   + monitoring/security
   + provider API or platform licensing
   + support/operations) / completed applications
  + incremental OCR/model services, if enabled
  + caseworker exception-handling time
```

The largest unknown is likely to be provider licensing/partnership terms and operational support, not the deterministic browser runner. Public API availability does not imply that every client plan includes API access; for example, Apricot advertises API access with its higher service tiers. Pricing must be confirmed with each provider and customer contract.

## Illustrative infrastructure-only floor

This example is intentionally narrow: 10,000 completed applications per month, 100 federated caseworkers, fewer than two million gateway and container requests, one small shared-core Cloud SQL instance, and workload within published free compute allowances.

| Component | Public pricing assumption | Illustrative monthly amount |
| --- | --- | ---: |
| Google Cloud API Gateway | First 2 million calls/month free | $0 |
| Cloud Run | Within request-based free tier | $0 |
| Identity Platform SAML/OIDC | First 50 MAU free; next 50 × $0.015 | $0.75 |
| Cloud SQL `db-f1-micro` | $0.0105/hour × 730 hours | $7.67 |
| **Infrastructure-only floor** | Excludes storage, egress, logs, security, support, provider licenses, and labor | **$8.42/month, or about $0.00084/application** |

A highly available instance at the published $0.021/hour compute rate would raise this narrow floor to about $16.08/month, or $0.00161/application. A real production architecture will cost more because it needs backups/storage, logging, monitoring, secret management, networking, security controls, support, and sufficient capacity. Shared-core instances also do not carry an SLA.

Public references: [API Gateway pricing](https://cloud.google.com/api-gateway/pricing), [Cloud Run pricing](https://cloud.google.com/run/pricing), [Identity Platform pricing](https://cloud.google.com/identity-platform/pricing), and [Cloud SQL pricing](https://cloud.google.com/sql/pricing).

## Measurement plan for a credible unit cost

During the first authorized pilot, record only aggregate, PII-free counters:

- started, final-review-ready, and abandoned application counts;
- provider calls, retries, throttles, and bytes transferred;
- connector, OCR, and runner compute duration;
- checkpoint type and human-handling minutes;
- provider/platform fees allocated to the pilot; and
- support and incident hours.

Report infrastructure-only, software/platform, and fully loaded operational cost separately. Do not divide by starts when the decision needs cost per completed application.
