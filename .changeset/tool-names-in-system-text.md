---
"@kindgi/capabilities": patch
"@kindgi/adapter-model-openai-compat": patch
"@kindgi/adapter-model-anthropic": patch
---

An agent whose instructions name a tool by its id (`call acme.lookup_order`) now gets the tool called on Anthropic and OpenAI-compatible models. Those providers forbid dots in tool names, so the tool is sent as `acme__lookup_order`; a model told the dotted id would call a name it wasn't given, writing the call as text or having it dropped (measured on local models: 43% of such turns). The adapters now name the call's own tools in the system prompt by the names they're sent under: whole ids only, deterministically, at the wire boundary. The journal, the conversation and provenance keep the dotted ids. Gemini keeps dots and is unchanged. `nameToolsAsSent` (`@kindgi/capabilities/tool-names`) is the helper.
