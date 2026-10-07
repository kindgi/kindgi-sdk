---
"@kindgi/capabilities": patch
"@kindgi/api": patch
"@kindgi/adapter-model-anthropic": patch
"@kindgi/adapter-model-openai-compat": patch
"@kindgi/adapter-model-gemini": patch
"@kindgi/guardrails": patch
"@kindgi/cli": patch
---

**A guardrail judge on a model that thinks still gets its verdict.** Claude Sonnet 5.5 and Opus 5.5, Haiku 5.5, Gemini 3.8 Flash and OpenAI's GPT-6 models think by default, and their thinking counts against the output cap. A judge's 256 tokens could be gone before the verdict.
- `ModelInfo.thinking` (`{ mode: 'adaptive' | 'always', lowest }`) says how a model thinks and its vendor's setting for the least thinking. The HTTP API validates it (otherwise 400, reason `invalid-thinking`) and returns it; the Python client has `ModelThinking`.
- `ModelCallInput.thinking: 'lowest'` asks for that least. The anthropic adapter sends Sonnet 5.5's `between_tools` or Haiku 5.5's `disabled` with effort `low`, and Opus 5.5's effort `low` alone. The gemini adapter sends the thinking level (`LOW` on 3.8 Flash, which refuses `MINIMAL`; `MINIMAL` on 3.5 Flash-Lite). openai-compat sends `reasoning_effort`. A model without `thinking` gets nothing extra.
- A guardrail judge asks for it, and on a thinking model its cap is 256 + 2048 tokens (`JUDGE_VERDICT_TOKENS`, `JUDGE_THINKING_TOKENS`).
- The presets mark the models: anthropic's Opus, Sonnet and Haiku 5.5, gemini and gemini-api's 3.8 Flash and 3.5 Flash-Lite, openai's gpt-6.1-sol and gpt-6-luna. Re-register to pick the marks up.
