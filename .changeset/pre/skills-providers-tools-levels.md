---
"@kindgi/sdk": patch
---

**The providers skill and the TypeScript tools skill load in levels.** Each `SKILL.md` now holds what's true on every path and a table naming the file for each case, so a coding agent reads about 6 KB and then only the files its case needs, not the whole 32 KB (tools) or 45 KB (providers). The providers skill has a file per path (Anthropic and the one-key presets, OpenAI-compatible endpoints and Ollama, in-process ONNX, Vertex AI, Bedrock), and one each for Kindgi Cloud, keys and registration, the router and common mistakes. The tools skill has one each for handlers, secrets and connections, HTTP specs, the `mutating` and approval flags, iterating and testing, and common mistakes. `kindgi skills sync` installs every file. The providers skill's description is now under the 1,024-character limit.
