---
"@kindgi/cli": patch
---

**`kindgi deploy` says where runs already in flight send their tool calls, for the way the runtime routes them.** It said they "continue on their pinned image", which isn't true with one pack service. With one pack service (the default in the Docker, Cloud Run and Azure Container Apps setups), every tool call goes to the build that service runs, whatever version the call names, so a run in flight that calls a tool version that build doesn't have fails there with `tool-version-mismatch`; the banner now says so. On a runtime that routes per deployment (the deployment has a pack service of its own), each tool call goes to the newest deployment that shipped the version it names, and the banner says runs in flight keep their tool versions. A replayed deploy's note names the image digest that landed before.
