---
"@kindgi/cli": patch
---

**The `sample` template says it has three tools.** `kindgi init --template=sample` scaffolds `echo`, `greet` and `fetch-httpbin`, and `kindgi dev` loads all three, but the pack's README, `package.json` and `kindgi.config.ts` said two. They say three now, the README's layout lists `fetch-httpbin`, and it says the agent uses `echo` and `greet`.
