# Common mistakes

## Contents

- 0. `adapter_id` uses the short name.
- 1. `envName` mismatch between the key and the provider's `secret_ref`.
- 2. Missing `features` on the model.
- 3. Empty `models[]`.
- 4. Setting `secret_ref` for the in-process adapter.
- 5. Registering the same provider id twice with different config.
- 6. Key not found by the runtime.
- 7. Forgetting to restart `kindgi dev` after registering a provider.
- 8. Compound `preferredProvider` strings.
- 9. Replies still come from dev-echo
- 10. A setting the adapter can't use.
- 11. A provider registered by hand under `kindgi dev`, with nothing committed.

0. **`adapter_id` uses the short name.** The `adapter_id` field must
   be the FULL npm package name of the adapter — `"@kindgi/adapter-model-anthropic"`,
   NOT `"anthropic"`. Adapters are registered with the runtime under
   their full package names, and a short name matches none of them, so
   registering is refused: the runtime has no adapter by that name
   (`✗ /adapter_id: …`). The model adapters are
   `@kindgi/adapter-model-anthropic`, `@kindgi/adapter-model-gemini`,
   `@kindgi/adapter-model-openai-compat`,
   `@kindgi/adapter-model-azure-openai`, `@kindgi/adapter-model-bedrock` and
   `@kindgi/adapter-model-in-process`; `kindgi providers presets` shows
   the id each preset uses.

1. **`envName` mismatch between the key and the provider's `secret_ref`.**
   The runtime reads a provider's key in the environment its
   `secret_ref.envName` names, at tenant scope. The SecretBinding refuses
   to cross-resolve, so a key held under another environment gives
   `secret-not-found` at agent-turn time. Where each one lands:
   `kindgi secrets set` needs `--env=<name>`; `kindgi providers register
   --preset` writes `--env`'s name, or `local` without it; a `--spec` file
   names its own (`"secret_ref": {"envName": "production", ...}`). Under
   `kindgi dev`, `local` is the project's env files (`.env`, `.env.local`)
   and `.kindgi/secrets.env`; any other name is `.env.<envName>`. Match
   them. On Kindgi Cloud, both are `prod`.

2. **Missing `features` on the model.** Agent declares
   `capabilities: [{needs: [{feature: 'tool-use'}]}]`; at least one
   model inside `metadata.models[]` must list `"features":
   ["tool-use"]` or the router filters every tuple out. If `kindgi
   runs start` returns "no provider satisfies capability", check the
   per-model `features` list — not a provider-level field anymore.

3. **Empty `models[]`.** Registration rejects with `empty-models`. Every
   provider row must expose at least one model. Duplicate `name` within
   the same array is also rejected (`duplicate-model-name`).

4. **Setting `secret_ref` for the in-process adapter.** `in-process`
   ignores `secret_ref` — no key needed. Leaving it in is harmless but
   noisy.

5. **Registering the same provider id twice with different config.**
   Returns `409 provider-already-registered`. Unregister first:
   ```sh
   kindgi providers unregister <provider-id>
   ```
   Then re-register.

6. **Key not found by the runtime.** `kindgi dev` reads the env files
   at the PACK ROOT (the directory with `kindgi.config.ts`, a Python
   pack's `pyproject.toml` with `[tool.kindgi]`, or a Java or Scala pack's
   `kindgi.config.json`) — `.env` and
   `.env.local`, or whatever `dev.envFiles` lists; the boot log prints
   which files it found. A `KINDGI_`-prefixed name is Kindgi runtime
   config and never resolves as a secret. Outside `kindgi dev`, the
   runtime resolves secrets through the deployment's `SecretBinding`
   (a KMS- or database-backed store, for example).

7. **Forgetting to restart `kindgi dev` after registering a provider.**
   You don't need to — provider registrations go to the running runtime
   over HTTP (`POST /v1/providers`), which invalidates the tenant's
   cached provider set. The next `kindgi runs start` sees the new
   provider.

8. **Compound `preferredProvider` strings.** `preferredProvider` is a
   provider (connection) id such as `'anthropic'`; the model is a
   separate choice. A value like `'anthropic-claude-sonnet-5-5'`
   (vendor + model baked together) matches no provider id, so the hint
   does nothing. Pin the model with a `models: { allow: [...] }`
   requirement instead.

9. **Replies still come from dev-echo** (`⚠ dev-echo isn't a real model: …`
   then `Tool responded: …`; the turn's result has the `fallback-provider`
   and `dev-echo-not-a-model` warnings). dev-echo is a fallback: it
   answers only when no registered provider satisfies the agent. So your
   provider doesn't — check its models' `features` against the agent's
   `capabilities.needs` (mistake 2), a `models` / `providers` allow-list
   that names nothing registered, and the tenant's policy. `kindgi
   providers list` shows what is registered.

10. **A setting the adapter can't use.** Registering checks the spec
    against its adapter (no network call, no key read) and refuses what
    it can't use: `422 provider-config-invalid`, nothing stored, one line
    per problem with its JSON-pointer path:
    ```text
    Error [invalid-request]: Provider "ollama" doesn't fit adapter @kindgi/adapter-model-openai-compat: adapter_config.api must be one of responses, chat-completions.
      ✗ /adapter_config/api: adapter_config.api must be one of responses, chat-completions.
    ```
    Fix each `✗` line's setting and register again. A key the adapter
    needs is checked too (`✗ /secret_ref: …`); whether the key works, or
    the endpoint answers, isn't (the first turn finds out). So is each
    `adapter_config` key: one the adapter doesn't take is refused, naming
    the ones it takes (`✗ /adapter_config/timeout: adapter_config.timeout
    isn't a setting of this adapter: it takes baseURL, api,
    extraBody.<field>.`), and one that moved names its new place. A
    registration stored before 0.1.5 wasn't checked: `kindgi doctor`
    names its problems (`GET /v1/providers/<id>/check`); unregister it
    and register it again. A stored registration with a key its adapter
    doesn't take still builds, without reading it: the check lists it in
    `warnings`, apart from `issues`, and `kindgi doctor` shows it as a
    warning.

11. **A provider registered by hand under `kindgi dev`, with nothing
    committed.** `kindgi providers register` puts it in this worktree's dev
    database only. Another worktree, a `kindgi dev --reset`, or a
    teammate's `kindgi dev` has no provider, and its turns land on
    dev-echo (mistake 9). Declare the provider in the pack's config and
    commit it (step 2 of your path). `.kindgi/dev/providers.json` isn't the file to
    commit: it's `kindgi dev`'s local record of what it registered, and
    `.kindgi/` is gitignored.
