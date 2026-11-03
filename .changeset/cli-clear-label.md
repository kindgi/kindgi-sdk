---
"@kindgi/cli": patch
---

`--clear-label` takes a schedule's, a webhook trigger's or a mail trigger's label off. On update, an empty or blank `--label=` is now a usage error that names `--clear-label`, and the label is saved trimmed.
