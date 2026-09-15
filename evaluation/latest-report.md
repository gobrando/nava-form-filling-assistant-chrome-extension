# Extraction quality evaluation

Generated: 2026-09-15T23:12:16.304Z

Result: **PASS**

| Metric | Result | Threshold |
| --- | ---: | ---: |
| Precision | 100.0% | ≥ 95.0% |
| Recall | 91.2% | ≥ 80.0% |
| Expected-abstention accuracy | 100.0% | ≥ 100.0% |
| Wrong extracted values | 0 | ≤ 0 |
| Sensitive evidence leaks | 0 | ≤ 0 |

| Fixture | Field-set result | Proposed fields | Withheld | Mean OCR confidence | Corrected rotation | Runtime |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| clean-client | Safe omission | 9 | 1 | 95% | 0° | 0.4s |
| low-contrast-client | Safe omission | 4 | 1 | 95% | 0° | 0.2s |
| rotated-business | Exact | 7 | 0 | 95% | 270° | 0.7s |
| table-business | Safe omission | 6 | 1 | 95% | 0° | 0.3s |
| bilingual-client | Exact | 5 | 0 | 93% | 0° | 0.3s |
| unsupported-handwriting | Exact | 0 | 0 | 95% | 0° | 0.1s |

The corpus contains only synthetic fictional records. OCR runs locally with the pinned English fast model. The base confidence floor is 70%; email uses 94%, SSN/EIN uses 90%, and suspicious name artifacts are withheld. “Safe omission” means one or more expected fields were withheld, while no wrong value was accepted. The unsupported handwriting fixture is expected to produce no fields. The JSON companion contains masked per-field results and page-region provenance.
