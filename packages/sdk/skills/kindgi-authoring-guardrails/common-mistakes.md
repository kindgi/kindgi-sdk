# Common mistakes

1. **Confusing guardrail and check.** The id in `agent.guardrails: [...]`
   is the GUARDRAIL id, not the check id. The agent binds to
   guardrails; guardrails reference checks.

2. **A check whose `evaluate` always returns `passed: true`.** If you
   are stubbing the check, give the guardrail `action: { 'on-violation':
   'log-only' }` so it is honest about not being enforced. An
   `llm-judge` guardrail's pass-only check isn't a stub: the judge
   enforces the guardrail, so keep its action.

3. **Calling a model from a pack check.** Pack checks receive empty
   `bindings`; there is no provider registry to route through. Declare
   an `llm-judge` guardrail with a rubric instead.

4. **Not declaring `configSchema`.** Without it, `config` is
   `Record<string, unknown>` — no validation, no editor completion,
   silent typos. Prefer Zod for TS-side inference on
   `evaluate(config, ...)`.

5. **Ignoring the `Result` from `validateGuardrail`.** It returns
   `Result<Guardrail, …>`; check `kind` and throw at load time.
   `defineCheck` itself throws when its `configSchema` can't be
   compiled.

6. **A named export only.** The indexer reads a guardrail file's default
   export; a file without one is `no-default-export`, and `kindgi build`
   refuses the pack. Export the check by name and the declaration as
   `export default`.
