# @kindgi/env-schema

Machine-readable registry of the Kindgi runtime's operator-facing env
vars. Single source of truth for:

- **Boot-time validation** — `validateEnvForTarget` reports the
  required vars a deployment target is missing.
- **`.env.example` scaffolding** — `renderEnvExample` renders
  `KINDGI_ENV_SCHEMA` (or a filtered part of it) as an `.env.example` body.
- **Tools and coding agents** — `import { KINDGI_ENV_SCHEMA }`
  to introspect deployment-config surface without parsing source.

## Adding a new env var

Append one entry to `KINDGI_ENV_SCHEMA` in
`packages/env-schema/src/schema.ts`. A `KINDGI_*` var that is not
declared there is invisible to `envVarsForTarget`,
`validateEnvForTarget` and `renderEnvExample`.

```ts
{
  name: 'KINDGI_MY_NEW_VAR',
  description: 'One-line human-readable explanation.',
  example: 'realistic-placeholder',
  required: true,   // false = optional (default applies)
  appliesTo: (t) => t.secretsBackend === 'postgres',
  group: 'secrets',
  allowedValues: ['a', 'b', 'c'], // optional enum hint
},
```

## Targets

An `EnvTarget` narrows the vars to one deployment's choices. Every
field is optional:

- **`component`**: which process reads the env, the Kindgi `server`
  (the default) or the `pack-service`, the separate process that runs
  a pack's code (its tools and guardrail checks). The pack service's
  target lists `KINDGI_PACK_SERVICE_TOKEN`, `KINDGI_PACK_INDEX`,
  `KINDGI_PACK_SERVICE_MAX_CONCURRENCY` and `KINDGI_PACK_ENV_CHECK`, and
  none of the server's vars.
  It also listens on `PORT` (default 8080), the platform convention,
  which isn't a Kindgi variable.
- **`secretsBackend`**, **`secretsBackendKms`**: the server's secrets
  backend and its KMS vendor.
- **`packTransport`**: `http` when the server calls a pack service at
  `KINDGI_PACK_SERVICE_URL`. Its token (`KINDGI_PACK_SERVICE_TOKEN`,
  shared with the pack service) is then required, and
  `KINDGI_PACK_CALL_TIMEOUT_MS` and `KINDGI_PACK_SERVICE_AUTH` apply.

## What lives here

- **`KINDGI_*` (operator-facing)** → declared here. Anything an
  operator sets in their Docker Compose / K8s ConfigMap / `.env` file.
- Internal opt-in switches that are not deployment config are not
  declared here.

## API

```ts
import {
  KINDGI_ENV_SCHEMA,
  envVarsForTarget,
  renderEnvExample,
  validateEnvForTarget,
  type EnvTarget,
  type EnvVarSpec,
} from '@kindgi/env-schema';

// Filter to just vars that apply to a target.
const target: EnvTarget = { secretsBackend: 'postgres', secretsBackendKms: 'gcp' };
const vars = envVarsForTarget(target);

// Render as .env.example body.
const body = renderEnvExample(vars);
writeFileSync('.env.example', body);

// Validate a resolved env at boot.
const result = validateEnvForTarget(process.env, target);
if (!result.ok) {
  throw new Error(`Missing required env vars: ${result.missing.join(', ')}`);
}
```

## Dependencies

Apache 2.0. `src/` has no imports, so tooling and the runtime can
both consume it.
