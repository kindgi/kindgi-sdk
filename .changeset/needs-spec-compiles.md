---
"@kindgi/tools": patch
"@kindgi/api": patch
---

**A tool whose `needsSpec` schema wouldn't compile is refused up front.** Each schema in `needsSpec.secrets` and `needsSpec.env` must compile as the runtime compiles it when it loads the tool, and an env value's `default` must be a string. Before, a pack with one the runtime couldn't compile (an unknown keyword, say) deployed fine, and then the runtime left that tool out, so calls to it failed as an unknown tool. Now `defineTool` refuses it (`invalid-tool-definition`), and so do `POST /v1/tools` (`400 validation-failed`) and a deployment (`400 deployment-validation-failed`). The message names the tool, the slot and the name (`Tool "acme.sign": the schema for needsSpec.secrets.SIGNING_KEY doesn't compile: …`), and the issue's path is `/needsSpec/<slot>/<name>`.
