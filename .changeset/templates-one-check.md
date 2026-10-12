---
"@kindgi/agents": patch
"@kindgi/api": patch
---

Templates pass one check wherever they come in, and render with one Liquid engine under the tenant input bounds.

- New in `@kindgi/agents`: `templateProblem(template)`, the check. The renderer and the check share one Liquid engine.
- An agent's instructions are now checked when the agent is defined (`defineAgent`, `POST /v1/agents`) and deployed (`POST /v1/deployments`), as a prompt block's template already was when published. A deployment with one such agent is refused whole. The check refuses a template:
  - longer than `liquid.parseLimit`;
  - that uses `{% include %}`, `{% render %}` or `{% layout %}`, with "templates can't use include, render or layout";
  - that is Liquid the renderer won't parse, an unknown filter included.

  Before, such instructions were accepted and then failed at every render. A template already stored with one still fails when it's rendered, and nothing stored is changed. To write `{{` or `{%` as text, put it in `{% raw %}…{% endraw %}`.
- A prompt block whose template uses an unknown filter is refused when it's published. The renderer always refused it.
- Rendering runs under the bounds' `liquid` limits: `parseLimit`, `renderLimitMs` and `memoryLimit`. On a self-hosted server only `memoryLimit` applies, at 16,777,216; `parseLimit` and `renderLimitMs` don't. `memoryLimit` counts what a render's filters and ranges make and what it writes, its captures included, as each is made. An array counts its items, each at least 1, nested arrays included; each distinct array is walked once, and counted every time it's held. A render past a limit fails, saying which.
- A drafted template longer than it may be is refused on its length alone, before it's parsed.
