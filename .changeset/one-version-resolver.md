---
"@kindgi/tools": minor
---

**`pickVersion` and `latestVersion`: one rule for picking a version from a range.** `@kindgi/tools` now exports the rule the tool registry uses when a turn resolves an agent's tool ranges. A range picks the highest version it allows. A prerelease is picked only when the range names one, as in npm. With no range, the pick is the latest version. Other places that turn a range into a version use the same rule: the runtime's registries, `kindgi dev`, and (next) the versions an agent version pins when it's published. So a pin is always the version a run would have picked. `createToolRegistry`'s `resolve` behaves as before.
