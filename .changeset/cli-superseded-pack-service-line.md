---
"@kindgi/cli": patch
---

**`kindgi deploy --hosted` and `kindgi deployments` say why a `superseded` deployment's pack service was taken down by the rule the runtime applies.** They said "a later deploy ships every tool version and check this one does", which leaves out its project and is the rule before runtime 0.4.0. They now say "no new call needs it, or a later deploy into its project ships every tool version and check it does": the first is the rule since 0.4.0, and the second still retires a deployment whose endpoint an earlier runtime made or last set.
