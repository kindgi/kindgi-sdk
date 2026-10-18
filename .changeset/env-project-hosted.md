---
"@kindgi/cli": patch
---

**On a runtime that keeps its values under one env, `--env` can name one of the pack's environments: a value then goes to that environment's project.** A pack config's `environments.<name>.project` names the project an environment runs in. On a runtime that refuses other envs (whoami's `servedEnv.refusesOtherEnvs`), `--env=<name>` naming such an environment means that project, under the env the runtime serves:
- **`kindgi secrets list|get|set|rotate|revoke|pull`** store and read at that project's scope. A `--scope` given with it may only name that project, as `--scope=project` or `--scope=project:<its id>`; any other scope is refused before anything is sent.
- **`kindgi env set|list|unset --scope` and `kindgi env pull`** do the same. `--scope=project` alone is the environment's project; without `--scope`, `kindgi env set|list|unset` edit the pack's env files, as before. `kindgi env pull` needs no `--scope` for such an environment.
- **`kindgi deploy --env=<name>`** deploys into that project, and `--sync-secrets` stores the environment's secrets there, under the served env. A `--project` naming another project is refused before the build.
- **`kindgi providers register --preset --env=<name>`** names its key under the served env, and says to store the key in each environment with `kindgi secrets set <KEY> --env=<name>`.
- The output starts with the environment, its project and the env its values are under. Pulled files are named by the environment.
- The project may be named by id or slug. A slug that names no project, or several, is refused, with nothing sent.
- **A write under an env the runtime doesn't serve** is still refused (`env-not-served`), and the refusal now names the pack's environments that have a project, and how to give one a project. Reads and deletes under any env still pass, to find and remove what was stored before.
- A runtime that takes any env, or names none, is unchanged.
