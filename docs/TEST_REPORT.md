# Test report

Date: 2026-09-14

## Automated checks

Run from the repository root:

```bash
npm run check
npm test
```

The suite covers canonical client and business records, field mapping and formatting, masked-value verification, document extraction, bundled-parser and storage boundaries, Manifest V3 configuration, and the no-submit contract. It also statically verifies the multi-page runner's allowlisted continuation, loop guard, page limit, and final-action boundary.

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
