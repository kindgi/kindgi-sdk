---
"@kindgi/agents": patch
"@kindgi/bounds": patch
---

**A turn can render its agent's instructions in a child process, off the thread that runs it.** `InvokeAgentBindings` takes an optional `templateRenderer` (`TemplateRenderer`). The render-prompt step awaits it, with the same checks before the render and the same result or error after it as `renderInstructions`. Without one, the turn renders in-process, as before.
- New subpath `@kindgi/agents/render-worker` (Node only): `createWorkerTemplateRenderer({ workers, maxOldSpaceMb? })` renders in child processes — a thread would share the server's heap, so a template that exhausts it would take the whole server down; a child has its own.
  - A render past `liquid.renderLimitMs` has its worker stopped, wherever the render is, so a template can't hold up the server's own thread.
  - A render past the worker's heap cap (`maxOldSpaceMb`, Node's `--max-old-space-size`) fails with the memory limit's message.
  - The fork is explicit: the child gets an empty environment (never the server's database URLs, KMS settings or tokens, beside untrusted templates), its flags are the heap cap alone, and no file descriptors beyond the IPC channel.
  - A stopped worker is replaced, and waiting tenants take turns.
  - `close()` lets the renders it took finish, then stops the workers.
- `TemplateRenderError` (`missing-parameter` or `render-failure`) is what a renderer rejects with for the template's own failure.
- `TenantTimeBudget.admit(tenant)` (`@kindgi/bounds`) is for work that runs off the thread that admits it (a child process, say). It checks the tenant's budget now and returns a `TenantWork`, whose `start()` and `end()` charge the time between them. A worker's render counts toward the tenant's render budget from when a worker takes it.
