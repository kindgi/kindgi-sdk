---
"@kindgi/client": patch
---

**The Python client reads `secrets.rotate`'s 202 as an async rotation.**
- **The bug:** every answer was validated against the sync model, so an async provider's `202 { kind: "async", rotationId, statusUrl, eventsUrl }` raised `invalid-response`.
- **The fix:** the client picks the model by status, as the Java client does: `201` → `SecretRotateResponseSync`, `202` → `SecretRotateResponseAsync`.
- **The method returns their union.** Tell them apart by `answer.kind == "async"` or `isinstance`; pyright and mypy narrow on either.
- **The generator** does this for any operation whose 2xx answers carry different models. `secrets.rotate` is the only one today.
