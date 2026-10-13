---
"@kindgi/agents": patch
---

Prompt templates resolve no partials: `{% include %}`, `{% render %}` and `{% layout %}` fail the render, whatever the name, and a drafted template that uses one is refused.
