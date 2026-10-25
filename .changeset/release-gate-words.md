---
"@kindgi/api": patch
---

**The release gate's messages use the same words as the rest of the product.**
- "The comparison" is now "the test run": "The test run completed.", "The test run used test cases acme.drafting-set 1.0.0; the policy needs acme.drafting-set 2.0.0."
- The version being made live is "this version", and the one it's measured against is "the live version": "The test run measured this version against the live version, acme.drafting 1.2.0."
- For an org, judgments from every project say so: "The judgments came from every project, which covers org …".
- "Restricted judge classes" are now experts' judgments: "The policy counts only experts' judgments; the test run counted everyone's. Re-run it with `classWeights: 'restricted-only'`."
- A test run on a part of the test cases says which: "the cases Improve learned from", or "the cases Improve didn't learn from" (`part: 'hold-out'`).
- The metric labels are "The weighted share marked right" and "The share of answers judged". "Precision at k" stays.
- Check names, `evalRunId`, `classWeights` values, `pinsDigest` and the metric names don't change.

**The improve schedule says "answers marked wrong".** Its descriptions in the API spec and its `threshold` refusal said trusted "no" judgments. The refusal now reads "…how many answers marked wrong since the last Improve run (default 5), across how many runs (3) and from how many judges (2)…". The input's description gives the rule: everyone's corrections count until a restricted (experts') judge class is named, then experts' only, as `classWeights` counts them.
