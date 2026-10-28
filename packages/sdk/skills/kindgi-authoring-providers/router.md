# How the router picks between multiple providers + models

## Contents

- The order the router sorts (provider, model) tuples in
- Practical rule: preferences rank, they never exclude
- A/B testing across vendors

When an agent turn fires, the router expands each registered provider
into one entry per model (`metadata.models[]`), filters the resulting
(provider, model) tuples against the agent's `capabilities.needs` (and
tenant policy), then sorts survivors in this order:

1. **Preferred provider / model.** Tuples matching the agent's
   `preferredProvider` and `preferredModel` are promoted to the front.
     - Both set → promote the exact tuple.
     - Only `preferredModel` set → promote any provider exposing that model.
     - Only `preferredProvider` set → promote every model of that provider.
   `defineAgent` takes both (`preferredProvider`, `preferredModel`), and
   so does a Python `Agent` (`preferred_provider=`, `preferred_model=`) and
   a Java `Agent.define(…)` (`set("preferredProvider", …)`).
2. **`capability.prefer[]` weights.** If the agent's capability
   declares `prefer: [{feature: 'thinking', weight: 3}, ...]`, tuples
   with matching model features (or provider attributes) get higher
   scores. Sorted by summed score, descending.
3. **Deterministic tiebreak.** When scores tie, tuples sort by provider
   id, then the provider's `defaultModel` before its other models, then
   model name — replay-safe and stable. A provider without a
   `defaultModel` falls back to its first model by name.

**Practical rule:** preferences are soft — they rank, they don't
exclude. To guarantee which model runs, make it a hard requirement in
the capability: `{ models: { allow: ['claude-sonnet-5-5'] } }` (and
`{ providers: { allow: ['anthropic'] } }` to pin the connection). If no
registered tuple satisfies it, the turn fails with
`capability-routing-failed` instead of silently using another model.

**A/B testing a specific agent across models within one Anthropic
registration:**

```ts
// agents/weather-agent-sonnet/index.ts
defineAgent({
  id: 'my-pack.weather-agent-sonnet',
  // …same name, instructions, tools, retrieval and guardrails as the opus variant
  capabilities: [
    { needs: [{ feature: 'tool-use' }, { models: { allow: ['claude-sonnet-5-5'] } }] },
  ],
  preferredProvider: 'anthropic',
});

// agents/weather-agent-opus/index.ts
defineAgent({
  id: 'my-pack.weather-agent-opus',
  // …
  capabilities: [
    { needs: [{ feature: 'tool-use' }, { models: { allow: ['claude-opus-5-5'] } }] },
  ],
  preferredProvider: 'anthropic',
});
```

The same pair in a Python pack (`kindgi.Agent`; module-level, one file each):

```python
# agents/weather_agent_sonnet.py
weather_agent_sonnet = Agent(
    id="my-pack.weather-agent-sonnet",
    # …same version, name, instructions, tools and guardrails as the opus variant
    capabilities=[
        {"needs": [{"feature": "tool-use"}, {"models": {"allow": ["claude-sonnet-5-5"]}}]},
    ],
    preferred_provider="anthropic",
)

# agents/weather_agent_opus.py
weather_agent_opus = Agent(
    id="my-pack.weather-agent-opus",
    # …
    capabilities=[
        {"needs": [{"feature": "tool-use"}, {"models": {"allow": ["claude-opus-5-5"]}}]},
    ],
    preferred_provider="anthropic",
)
```

Both agents share the tool + instructions; only the pinned model
differs. One Anthropic provider registration + one API key covers
both. Register the provider once, then invoke each agent to compare
outputs on the same inputs.

**A/B testing across vendors:**

```ts
defineAgent({
  id: 'my-pack.weather-agent-groq',
  // …
  capabilities: [
    { needs: [{ feature: 'tool-use' }, { models: { allow: ['llama-3.3-70b-versatile'] } }] },
  ],
  preferredProvider: 'groq',
});

defineAgent({
  id: 'my-pack.weather-agent-anthropic',
  // …
  capabilities: [
    { needs: [{ feature: 'tool-use' }, { models: { allow: ['claude-sonnet-5-5'] } }] },
  ],
  preferredProvider: 'anthropic',
});
```
