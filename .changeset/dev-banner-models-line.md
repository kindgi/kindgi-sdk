---
"@kindgi/cli": patch
---

**`kindgi dev`'s banner says what models your agents have, in plain words.** The `Providers` line is now `Models`:
- With a real model, it lists each provider with its models, and leaves out dev's fallback.
- With none, it says `none yet`, what agents do meanwhile (placeholder replies under `kindgi dev`; failed turns on a runtime with no fallback), and links the guide to connecting a model.

`kindgi init`'s next steps say the same, with the same link. The `providers register` command stays in `kindgi doctor`, which names the preset and the key to set.
