---
"@kindgi/compliance": patch
---

**A classifier can keep a kind's audit events for as long as the tenant exists, with no number of days.**
- **`Classification.retention.kept?: true`:** retention cleanup never deletes the kind's events by age; they go when the tenant is purged. It overrides `days` and `onDenyDays`. Unlike `legalHold`, an erasure still erases them.
- **`days` stays required on `Classification`.** A loader fills a kept kind's `days` in, so a reader that predates `kept` still finds a number. That number isn't the kind's retention: whatever applies or shows a kind's retention checks `kept` first, and shows "kept".
- **`ClassificationSource`** (new): a classification as a classifier file writes it. Its `retention` gives `days` (and optionally `onDenyDays`), or `kept: true` with neither `days` nor `onDenyDays`, with `legalHold` either way. `ComplianceClassifierSource`'s `default` and `byKind` entries are `ClassificationSource`s now. A `Classification` without `kept` is already a `ClassificationSource`, so existing files and sources still load unchanged. A loader typed on `ComplianceClassifierSource` that reads `retention.days` no longer compiles: it reads `kept` first.
