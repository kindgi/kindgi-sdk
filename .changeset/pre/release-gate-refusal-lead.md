---
"@kindgi/api": patch
---

**A release gate refusal starts "The release gate policy refused".** A `gate-failed` error's message read "The gate refused acme.order-desk 1.3.0: …"; it now reads "The release gate policy refused acme.order-desk 1.3.0: …", the name the console uses for the policy. Only the message's wording changed: the error code, its status and its details (`promotionId`, `policy`, `checks`) are the same.
