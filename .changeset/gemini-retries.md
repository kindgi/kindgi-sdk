---
"@kindgi/adapter-model-gemini": patch
---

The Gemini adapter retries a call that fails with a transient status (408, 429, 500, 502, 503, 504): three attempts in all, backing off from a second. Before, it didn't retry at all. The `@google/genai` client retries only when it's told to, so one `503` from an overloaded model failed the turn. The OpenAI-compatible and Anthropic adapters already retried, through their SDKs' defaults (also three attempts). A failed connection still isn't retried on Gemini. A call's `attempts` counts its retries.
