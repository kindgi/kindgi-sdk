---
"@kindgi/tools": minor
"@kindgi/api": minor
"@kindgi/specs": minor
"@kindgi/client": minor
"@kindgi/sdk": minor
"@kindgi/cli": minor
---

**An HTTP tool's `secretRef` can leave its env out.** `authorization.secretRef.envName` is optional in `tool.schema.json`, in `@kindgi/tools`' `ToolSecretRef` and in the API's `ToolSecretRef`. Left out, the secret is read in the env the runtime serves (`KINDGI_ENV`; `local` under `kindgi dev`), as the secrets a tool's code declares are, so one tool works unchanged in every env. A ref that names its env still reads there. The ref is stored as given, so a tool registered or deployed without an env reads in whatever env the runtime calling it serves. A runtime from before this release refuses a ref without an env when the tool is registered or deployed.

On a runtime that refuses other envs (`refuseOtherEnvs`), `POST /v1/tools` and `POST /v1/deployments` answer `409 env-not-served` for a tool whose `secretRef` names an env other than the served one, with `details.envName` and `details.servedEnv`. A deploy refuses that tool before anything is stored, even when it would keep a version already published. To read the secret under the served env, leave `envName` out.

**Breaking for code that reads a ref's env.** `ToolSecretRef.envName` is now `string | undefined`, in `@kindgi/tools` and in `@kindgi/client`'s types. A harness or a test that resolves a tool's secret from its ref, such as `resolveSecret: (ref) => store.get(ref.envName, ref.name)`, no longer compiles. The fix is one line: read the env it serves when the ref names none, `resolveSecret: (ref) => store.get(ref.envName ?? env, ref.name)`. Every manifest that names its env stays valid. A Python or JVM client from before this release fails to read a tool whose ref names no env, or a page of tools that holds one, so upgrade the client with the runtime.

The authoring skills, the sample pack's HTTP tool and the docs leave the env out, and the skills say when to name one.

Release-decision: a minor, in the release that takes this change, the maintainers, 2026-11-07
