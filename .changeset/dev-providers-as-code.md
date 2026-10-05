---
"@kindgi/cli": patch
---

**`kindgi dev` registers the model providers the config declares.** List them as `providers` in `kindgi.config.ts`, or as `[[tool.kindgi.providers]]` tables in `pyproject.toml`. Each one is a preset (`{ preset: 'gemini', project: 'acme-gcp', models: [...] }`, the choices `providers register --preset` takes) or a `{ spec: … }` registration body. They are then registered in every worktree's database, after `--reset`, and on a teammate's machine, with no `providers register` to repeat.

On each boot, `kindgi dev` keeps the runtime in step with the list:
- it registers a missing provider;
- it re-registers one it registered whose declaration changed;
- it unregisters one the config no longer declares.

It leaves alone any provider it didn't register. One registered differently gets a warning naming the `unregister` that lets the config's version apply. A provider whose key isn't in the env files is skipped, with one line naming the secret.

A key is always a secret's name: a `spec` with a credential in `adapter_config` is refused. Which providers `kindgi dev` registered is recorded in `.kindgi/dev/providers.json`, per database and tenant.
