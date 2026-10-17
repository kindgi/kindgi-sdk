---
"@kindgi/cli": patch
---

**`kindgi proposals improve` can start a prompt pass and tune which judgments it learns from.** The command only wired the budget, so these inputs the API already accepts couldn't be reached from the CLI.
- `--tier=settings|prompt` — what to tune (default `settings`). `prompt` has a model draft new prompt templates (a drafted proposal always waits for a reviewer).
- `--provider=<id> --model=<model>` — the provider and model that draft the templates for a prompt pass, given together.
- `--drafts=<n>` — how many templates to draft (`1` to `5`, `3` by default).
- `--class-weights=as-recorded|restricted-only` — which judgments the pass learns from (default `restricted-only`), the same spelling as `eval-runs start` and `proposals evaluate`.
- The command refuses the combinations the pass can't use with a flag-named message: `--tier=prompt` without `--provider` and `--model`, and `--provider`, `--model` or `--drafts` on a settings pass.
