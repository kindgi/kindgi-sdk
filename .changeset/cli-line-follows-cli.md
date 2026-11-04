---
"@kindgi/cli": patch
"@kindgi/sdk": patch
---

**The docs install the CLI of the release they describe.** The docs pages, the skills and the READMEs pinned the CLI's 0.2 line (`npx --yes @kindgi/cli@0.2`, `uvx --from "kindgi-cli>=0.2,<0.3"`), so a reader of later docs ran an older CLI than the one the docs describe. Each release now moves the install lines, and "Kindgi X.Y's CLI" and "Kindgi X.Y's client" in the prerequisites, to its own version: a release to its line, a release candidate to its exact build. CI fails when one is off its line.

- **Skills.** The Java, Python and Scala getting-started skills move to 0.1.10, 0.1.17 and 0.1.10, with the new install lines.
- **The CLI's README** installs the CLI of its own release too.
