---
"@kindgi/handler-runtime": patch
"@kindgi/specs": patch
"@kindgi/sdk": patch
"@kindgi/cli": patch
"@kindgi/pack-conformance": patch
---

**A pack's `llm-judge` guardrail is judged.** The pack index carries a guardrail's `judgeCapabilities` (`pack-index.schema.json`), so the runtime routes an `llm-judge` guardrail's judge model by them. Before, the index left them out, and the runtime refused the guardrail on every turn it applied to: with action `halt` the turn failed, and with any other action the turn went on unjudged. `kindgi build` and `kindgi dev` now refuse an `llm-judge` guardrail with no `judgeCapabilities`, naming it. A runtime that registered the guardrail from an earlier deploy, without them, refuses the next deploy of it as a changed definition (`guardrail-already-registered`): unregister it (`kindgi guardrails unregister <id>`) and deploy again. Under `kindgi dev`, the runtime reads the guardrail from the pack's index, so the judge needs runtime 0.3.1 or later there. The guardrails skills say how to declare one in each language, and the conformance fixture pack has one (`conformance.judged`).
