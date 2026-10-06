---
"@kindgi/cli": patch
---

`kindgi artifacts` and `kindgi capabilities` say why they aren't available: the Kindgi runtime doesn't serve `/v1/artifacts` (no blob storage wired) or `/v1/capabilities` (no capability catalog wired) yet. Before, they said only "not yet wired".
