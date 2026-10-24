---
"@kindgi/api": patch
---

**The release gate's messages use the same words as the rest of the product.**
- "The comparison" is now "the test run": "The test run completed.", "The test run used test cases acme.drafting-set 1.0.0; the policy needs acme.drafting-set 2.0.0."
- The version being made live is "this version", and the one it's measured against is "the live version", or "the version it would replace" where the scope matters.
- "Restricted judge classes" are now experts' judgments: "The policy counts only experts' judgments; the test run counted everyone's. Re-run it with `classWeights: 'restricted-only'`."
- A test run on a part of the test cases says which: "the cases Improve learned from", or "the cases Improve didn't learn from" (`part: 'hold-out'`).
- The metric labels are "The weighted share marked right" and "The share of answers judged". "Precision at k" stays.
- Check names, `evalRunId`, `classWeights` values, `pinsDigest` and the metric names don't change.
