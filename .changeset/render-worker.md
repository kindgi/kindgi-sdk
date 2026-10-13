---
"@kindgi/agents": patch
"@kindgi/bounds": patch
---

**A turn can render its agent's instructions off the thread that runs it.** `InvokeAgentBindings` takes an optional `templateRenderer` (`TemplateRenderer`). The render-prompt step awaits it, with the same checks before the render and the same result or error after it as `renderInstructions`. Without one, the turn renders in-process, as before.
- New subpath `@kindgi/agents/render-worker` (Node only): `createWorkerTemplateRenderer({ workers, resourceLimits? })` renders in worker threads.
  - A render past `liquid.renderLimitMs` has its worker stopped, wherever the render is, so a template can't hold up the server's own thread.
  - A render past the worker's heap fails with the memory limit's message.
  - A stopped worker is replaced, and waiting tenants take turns.
  - `close()` lets the renders it took finish, then stops the workers.
- `TemplateRenderError` (`missing-parameter` or `render-failure`) is what a renderer rejects with for the template's own failure.
- `TenantTimeBudget.admit(tenant)` (`@kindgi/bounds`) is for work that runs on another thread. It checks the tenant's budget now and returns a `TenantWork`, whose `start()` and `end()` charge the time between them. A worker's render counts toward the tenant's render budget from when a worker takes it.
