---
"@kindgi/api": patch
"@kindgi/cli": patch
"@kindgi/client": patch
"@kindgi/sdk": patch
"@kindgi/policy-contract": patch
"@kindgi/types": patch
"@kindgi/authz": patch
"@kindgi/specs": patch
---

**Eval suites are now test sets.** This is a breaking rename, and no old name is kept.

- **Routes.** `/v1/eval-suites` is `/v1/test-sets`, with `{testSetId}` in its paths; the sub-paths are the same, including `runs`.
- **Fields and values.**
  - `suiteId` is `testSetId` everywhere it names a test set, including on eval runs, and `suiteVersion` is `testSetVersion`.
  - A test set's and an eval run's kind `judged` is `corrections`.
  - A release gate's `comparison.suite` is `comparison.testSet`, and its check is named `comparison.testSet`. A comparison's summary says `testSet` where it said `suite`.
  - The retention domain `eval_suite` is `test_set`, and so is the authorization resource type.
  - A `reference-out-of-scope` issue names a test set with the kind `test-set` where it said `suite`.
- **Errors.** Codes starting `eval-suite-` start `test-set-`.
- **Schemas and types.** `EvalSuite*` names are `TestSet*`. `EvalKind` is `TestSetKind` (and `EVAL_KINDS` is `TEST_SET_KINDS`), and `CorrectedEvalCase`, `CorrectedEvalCaseCollectionPage` and `CorrectedEvalCaseCorrection` are `CorrectedTestCase`, `CorrectedTestCaseCollectionPage` and `CorrectedTestCaseCorrection`.
- **TypeScript client.** `client.evalSuites` is `client.testSets`.
- **Specs.** `@kindgi/specs/eval-suite.schema.json` is `@kindgi/specs/test-set.schema.json`, its `$id` is `https://kindgi.com/schemas/v1/test-set.schema.json` and its title "Test set", and its reference page is `reference/schemas/test-set/`. Its `kind` takes `corrections`, as the API does.
- **CLI.** `kindgi eval-suites` is `kindgi test-sets`, `--suite` is `--test-set`, and `--suite-version` is `--test-set-version`. `kindgi exports create` writes them as `test-sets` and `test-set-versions`.
