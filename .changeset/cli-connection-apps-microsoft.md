---
"@kindgi/cli": patch
---

**`kindgi connection-apps add microsoft --tenant=<directory>`: register the company's Microsoft Entra app.**
- `--tenant` names the directory people sign in at: the company's Microsoft tenant id or domain for a single-tenant app, or `organizations`, `common` or `consumers` for a multi-tenant one. Microsoft's entry names no default, so a Microsoft registration needs it.
- A GitHub App takes no `--tenant`, and is refused one.
