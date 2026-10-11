---
"@kindgi/compliance": patch
---

A compliance classifier file can give a kind another kind's classification by naming it: `"secret-rotated": "secret-set"` in `byKind`, so related kinds share one policy and can't drift apart. `ComplianceClassifierSource` is the file as written; a loader resolves the names into a `ComplianceClassifierFile` (every kind with its own classification), and refuses a name that names another name, or a kind that isn't listed with a classification of its own (`default` included).
