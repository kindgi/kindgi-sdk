---
"@kindgi/cli": patch
"@kindgi/api": patch
---

The CLI trusts the limited license signing key `lk-2026-l1` when it checks a renewed key; such a key verifies on runtime 0.7.0 or later. The destination delivery docs list `project-deleted` among the skip reasons.
