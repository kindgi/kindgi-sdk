---
"@kindgi/sdk": patch
"@kindgi/cli": patch
---

A `kindgi-using` skill, for packs in every language: the coding agent guides the person in using what was built, not only in building it. Each answer gives both, side by side: the read-only answer from the `kindgi` CLI in plain words, and the console page that shows the same thing, as a full link with the clicks. The skill maps the console's pages and their addresses, built from `kindgi console --no-open`, `kindgi auth whoami` and `kindgi projects get-default`. It answers the common questions: the tools and what each may change, what an agent looked up for an answer, the answers it finished, which guardrail stopped an answer, a waiting approval, what Kindgi remembers about a customer, a schedule's next run and its last answer, health, who has access, the answers you rated, and what answers cost. Guiding is read-only: deciding approvals, erasing, adding people, roles, API keys, making a version live and rating stay with the person, and the skill never reads a token file. `kindgi init` installs it, and the templates' `AGENTS.md` point to it.
