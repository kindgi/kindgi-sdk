---
"@kindgi/adapter-model-anthropic": patch
"@kindgi/adapter-model-gemini": patch
"@kindgi/adapter-model-in-process": patch
"@kindgi/adapter-model-openai-compat": patch
"@kindgi/agents": patch
"@kindgi/api": patch
"@kindgi/audit-events": patch
"@kindgi/audit-events-inmemory": patch
"@kindgi/authz": patch
"@kindgi/blob-binding": patch
"@kindgi/capabilities": patch
"@kindgi/cli": patch
"@kindgi/client": patch
"@kindgi/compliance": patch
"@kindgi/crypto": patch
"@kindgi/dev-echo-provider": patch
"@kindgi/dotenv-file": patch
"@kindgi/embedding": patch
"@kindgi/env-inmemory": patch
"@kindgi/env-schema": patch
"@kindgi/flow": patch
"@kindgi/guardrails": patch
"@kindgi/handler": patch
"@kindgi/handler-runtime": patch
"@kindgi/memory": patch
"@kindgi/pack-conformance": patch
"@kindgi/platform": patch
"@kindgi/policy-contract": patch
"@kindgi/provenance": patch
"@kindgi/runtime": patch
"@kindgi/sandbox": patch
"@kindgi/schema": patch
"@kindgi/sdk": patch
"@kindgi/secrets-dotenv": patch
"@kindgi/specs": patch
"@kindgi/testing": patch
"@kindgi/tools": patch
"@kindgi/types": patch
---

CommonJS apps can `require()` Kindgi. Every package's `exports` gives a `default` condition beside `import`, so `require('@kindgi/sdk/client')` loads the ES modules through Node's `require()` of ES modules, instead of failing with `ERR_PACKAGE_PATH_NOT_EXPORTED`. There's still one copy of each module, so the same code runs from either kind of app.

- Node 22.12 or later: every package's `engines.node` is `>=22.12.0` (Node loads ES modules with `require()` from 22.12 on), and so are the apps `kindgi init` creates.
- TypeScript that compiles to CommonJS needs TypeScript 5.8 or later with `module: nodenext`, or `moduleResolution: bundler` in an app a bundler builds.
- `@kindgi/handler-runtime`'s program entries (`pack-service-main`, `kindgi-index-main`) stay ES-modules-only: they run with `node`.
