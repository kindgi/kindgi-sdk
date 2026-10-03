# @kindgi/secrets-dotenv

The dev-mode `SecretBinding` — secrets for `kindgi dev`, straight from the
project's env files — plus the one definition of which env files belong
to a pack environment.

Not for production: plaintext on disk, no audit events, no versioning.
Deployed environments use a durable, encrypted `SecretBinding` or an
external secrets provider.

## Which files

| Environment | Files read (lowest precedence first) | Writes go to |
|---|---|---|
| `local` (`kindgi dev`) | `.env`, `.env.local` — or `dev.envFiles` from `kindgi.config.ts` | the last file (`.env.local`) |
| anything else | `.env.<envName>` | the same file |

Paths are relative to the pack root. For `local` these are the same files,
parsed the same way (`@kindgi/dotenv-file`: dotenv grammar, `${VAR}`
expansion), as the application beside the pack — Kindgi embedded in a
Next.js app sees exactly what `next dev` sees. A key already in the app's
`.env` is available to the pack without copying it anywhere.

```ts
import { readPackEnv, resolvePackEnvFiles } from '@kindgi/secrets-dotenv';

resolvePackEnvFiles({ packDir, envName: 'local' });
// → { read: ['<pack>/.env', '<pack>/.env.local'], write: '<pack>/.env.local' }

const env = await readPackEnv({ packDir, envName: 'local', env: process.env });
env.values; // merged + expanded; env.origin says which file supplied each name
```

## Runtime config vs. the pack's secrets

One file can hold both. The `KINDGI_` prefix is the line
(`isRuntimeKey`, `runtimeValues`, `packValues`):

- `KINDGI_*` — Kindgi's own runtime config (`KINDGI_DATABASE_URL`, …).
  Never visible through the binding, never written by it.
- everything else — the pack's. An app's own `DATABASE_URL` is just a name
  the pack could reference; it never configures Kindgi.

## The binding

```ts
import { createDotenvSecretBinding } from '@kindgi/secrets-dotenv';

const binding = createDotenvSecretBinding({
  packDir,
  localEnvFiles: ['.env', '.env.local'], // optional — dev.envFiles
  env: process.env, // optional — fallback for ${VAR} no file defines
});
```

- **Reads** (`list`, `get`, `resolve`, `getVersion`, `listVersions`): the
  merged, expanded view without `KINDGI_*`. Versions are synthetic
  (`versionId: 1`).
- **`set`**: `setKey` on the write target — one line changes, every other
  byte stays; atomic write, mode 0600. `create-new` reports
  `already-exists` if ANY of the files defines the name. Refuses
  `KINDGI_*`, the reserved `kindgi.` prefix, non-POSIX names, and values
  no dotenv quoting can hold.
- **`rotate` / `revoke`**: unsupported — the error names the files to
  edit.
- **Scope-blind**: dotenv files are flat; `Scope` is ignored.
- **`${VAR}`**: resolved across the files; `env` only fills names no file
  defines and never overrides a file's value. Nothing reads `process.env`
  unless you pass it.
