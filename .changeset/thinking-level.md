---
"@kindgi/capabilities": patch
"@kindgi/agents": patch
"@kindgi/guardrails": patch
"@kindgi/api": patch
"@kindgi/client": patch
---

**How much an agent's model thinks, and the level each call sent.** A model-settings block takes `thinking`, from `lowest` (as little as the model allows) through `minimal`, `low`, `medium`, `high` and `xhigh` to `max`, beside `temperature` and `maxOutputTokens`. The turn's model calls ask for it (`ModelCallInput.thinking`, which judges already set to `lowest`), and an improvement pass can try the levels a block's schema marks tunable. A model's `thinking` in a provider's `metadata.models` takes `levels`, the levels it takes besides `lowest`, least first, and a `default`, the level a call that asks none is sent. A `default` the model doesn't take is refused at registration, naming the ones it takes. Without `levels`, a model takes `low`, `medium` and `high`, plus `minimal` when its `lowest` is `minimal`. A level a model doesn't take is rounded to the next one it takes, or to its highest, and the call warns `thinking-level-adjusted`; a level asked of a model that doesn't think sends nothing and warns `thinking-unsupported`. `thinkingFor` and `thinkingLevelsOf` in `@kindgi/capabilities` work this out for an adapter. Each model call's cost record (`GET /v1/cost/records`) carries `thinking`: the level the call asked for (`asked`), the one sent (`level`) and the vendor's fields as they went out (`sent`). The turn record's `model-call` node and the `model.call.completed` event carry `asked` and `level`.
