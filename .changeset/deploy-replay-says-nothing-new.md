---
"@kindgi/cli": patch
---

**A deploy the server answers from its record of an earlier request says nothing new was deployed.** When `POST /v1/deployments` answers as a replay of an earlier request with the same `Idempotency-Key`, `kindgi deploy` prints "Nothing new was deployed: the server answered from its record of an earlier request with this Idempotency-Key (...)", and says to build again first if the pack changed since its envelope was built. It no longer prints "Deploy complete.", "Runs started from now use image ...", or the line on what runs already in flight call, for that answer. The JSON on stdout then adds `idempotentReplay: true`, and `outcome` keeps its two values.
