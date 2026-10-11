---
"@kindgi/capabilities": patch
"@kindgi/adapter-model-anthropic": patch
"@kindgi/adapter-model-openai-compat": patch
"@kindgi/adapter-model-shared": patch
---

**A tool whose id holds `__` can be called.** Anthropic, OpenAI-compatible endpoints, Bedrock and Azure OpenAI don't take dots in tool names, so a tool id goes to the model with `.` as `__`. The model's call used to come back with every `__` as `.`, so a tool named by an MCP server with `__` in it (Drupal's MCP Server Tool Bridge names every tool `tool_api__<id>`) came back as a tool nobody has, and the turn failed with `unresolved-tool`. A call's name is now looked up among the request's own tools. Two tools that would go to the model under one name (`acme.a__b` and `acme.a.b`) are refused before the call, naming both. Gemini takes dots, so its tool names were never changed. New in `@kindgi/capabilities`: `toolIdsBySentName()` and `ToolNameCollisionError`.
