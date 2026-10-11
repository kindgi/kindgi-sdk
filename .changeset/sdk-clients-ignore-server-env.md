---
'@kindgi/adapter-model-anthropic': patch
'@kindgi/adapter-model-openai-compat': patch
'@kindgi/adapter-model-gemini': patch
---

**A provider's calls carry nothing from the server's environment.** The model SDKs fill options a caller leaves out from environment variables, and three of those reached the calls of every provider the server runs:
- `@kindgi/adapter-model-anthropic`: the Anthropic SDK reads `ANTHROPIC_AUTH_TOKEN`, sent as a bearer beside the provider's own key, and `ANTHROPIC_BASE_URL`. The adapter now sets no bearer and names Anthropic's API itself when no base URL is given.
- `@kindgi/adapter-model-openai-compat`: the OpenAI SDK reads `OPENAI_ORG_ID` and `OPENAI_PROJECT_ID`, sent as headers to whatever base URL the provider names, and `OPENAI_ADMIN_KEY`. The chat and the embeddings providers now set none of them.
- `@kindgi/adapter-model-gemini`: `@google/genai` moves to Vertex AI, with the environment's project and location, when `GOOGLE_GENAI_USE_VERTEXAI` or `GOOGLE_GENAI_USE_ENTERPRISE` is set. A Developer API provider now stays on the Developer API.
