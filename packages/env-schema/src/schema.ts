// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Machine-readable registry of every operator-facing env var the Kindgi
 * runtime understands. Used for:
 *
 *   - Boot-time validation (`validateEnvForTarget`).
 *   - `.env.example` scaffolding (`renderEnvExample`).
 *   - Tools and coding agents that author packs —
 *     they `import { KINDGI_ENV_SCHEMA }` to introspect the current
 *     deployment-config surface.
 *
 * **Adding a new env var:** append an entry to `KINDGI_ENV_SCHEMA`. A
 * `KINDGI_*` var that is not declared here is invisible to
 * `envVarsForTarget`, `validateEnvForTarget` and `renderEnvExample`.
 *
 * **Every name carries the `KINDGI_` prefix — no exceptions.** Kindgi
 * often shares one `.env` with the application it is embedded in
 * (a pack added to an existing repository). The prefix is what keeps the two
 * apart: Kindgi's runtime reads only `KINDGI_*`, and every un-prefixed
 * name belongs to the application and the pack's agents. An un-prefixed
 * runtime var (`DATABASE_URL`) would silently pick up the host app's
 * value.
 *
 * **What lives here:** every var an operator sets in their deployment
 * config (Docker Compose, K8s ConfigMap, .env file). Internal opt-in
 * switches that are not deployment config are not declared here.
 */

/**
 * Caller's deployment-target choices. Each field narrows the set of
 * env vars that apply. Fields are all optional so callers can query
 * "what vars exist regardless of target" (pass `{}`) or "what vars
 * apply given `postgres + gcp`" (pass both fields).
 *
 * New target axes get added as optional fields — a var's `appliesTo`
 * predicate stays valid because it only reads the axes it cares about.
 */
export interface EnvTarget {
  /**
   * Which process reads the env: the Kindgi `server` (the default when
   * absent), or the `pack-service`, the separate process that runs a
   * pack's code (its tools and guardrail checks).
   */
  readonly component?: 'server' | 'pack-service';
  readonly secretsBackend?: 'none' | 'postgres' | 'secret-manager' | 'dotenv';
  readonly secretsBackendKms?: 'gcp' | 'aws' | 'libsodium' | 'vault';
  /**
   * How the server reaches the pack service: `http` when
   * `KINDGI_PACK_SERVICE_URL` is set. Absent: the server has no pack
   * service. Server only.
   */
  readonly packTransport?: 'http';
}

/**
 * Declarative shape of a single env var. `appliesTo` is a predicate
 * over the target so vars that span multiple targets (e.g.
 * `KINDGI_SECRETS_AAD_KEY_PATH` applies to `postgres + any KMS`)
 * declare one broad predicate instead of one entry per target.
 */
export interface EnvVarSpec {
  /** Full env var name, e.g. `KINDGI_SECRETS_GCP_PROJECT_ID`. */
  readonly name: string;
  /** One-line description used in `.env.example` comments + docs. */
  readonly description: string;
  /**
   * Realistic example value for `.env.example`. Never a real secret —
   * placeholders like `my-proj`, `us-central1`, `/etc/kindgi/aad.key`.
   * Empty string means "no useful example; caller must fill in."
   */
  readonly example: string;
  /**
   * `true` → `validateEnvForTarget` reports missing when the var
   * `appliesTo(target)` but the env doesn't set it.
   * `false` → optional; a default applies or the var is passthrough.
   */
  readonly required: boolean;
  /**
   * Predicate: does this var apply given the caller's target choices?
   * Vars that apply universally return `true` unconditionally.
   */
  readonly appliesTo: (target: EnvTarget) => boolean;
  /**
   * Optional group tag — used by `renderEnvExample` to cluster related
   * vars in the output. Groups appear in order of first appearance
   * (for `KINDGI_ENV_SCHEMA`: `core`, `secrets`, then vendor-specific
   * groups); ungrouped vars come last.
   */
  readonly group?: string;
  /**
   * Optional enum of valid string values. When set, tools can offer
   * autocomplete. Declarative only — `validateEnvForTarget` does not
   * check membership.
   */
  readonly allowedValues?: readonly string[];
}

// ---------------------------------------------------------------------
// Group ordering — output convention for `.env.example`.
// ---------------------------------------------------------------------

export const ENV_GROUPS = {
  core: 'Core server config',
  secrets: 'Secrets backend selection',
  gcp: 'GCP vendor config (postgres + gcp KMS)',
  'pack-service': 'Pack service (runs the pack code: tools and guardrail checks)',
  'image-registry': "Image registry (where deployments' images are read from)",
  dev: 'Development (`kindgi dev`; each needs `KINDGI_DEV=true`)',
} as const;

// ---------------------------------------------------------------------
// The registry.
// ---------------------------------------------------------------------

/** The server's own vars: every target but the pack service's. */
const appliesToServer = (t: EnvTarget): boolean => t.component !== 'pack-service';

const appliesToPostgresBackend = (t: EnvTarget): boolean =>
  appliesToServer(t) && t.secretsBackend === 'postgres';

const appliesToDotenvBackend = (t: EnvTarget): boolean =>
  appliesToServer(t) && t.secretsBackend === 'dotenv';

const appliesToPostgresGcp = (t: EnvTarget): boolean =>
  appliesToPostgresBackend(t) && t.secretsBackendKms === 'gcp';

const appliesToPackService = (t: EnvTarget): boolean => t.component === 'pack-service';

/** The server, calling a pack service over HTTP. */
const appliesToServerHttpPackTransport = (t: EnvTarget): boolean =>
  appliesToServer(t) && t.packTransport === 'http';

/**
 * Every operator-facing env var Kindgi understands, keyed by name.
 * Declarative source of truth. Consumers filter this via
 * `envVarsForTarget` / `validateEnvForTarget`.
 */
export const KINDGI_ENV_SCHEMA: readonly EnvVarSpec[] = [
  // ---- core server ------------------------------------------------
  {
    name: 'KINDGI_API_PORT',
    description: 'HTTP port the Kindgi API server listens on. Default 4000.',
    example: '4000',
    required: false,
    appliesTo: appliesToServer,
    group: 'core',
  },
  {
    name: 'KINDGI_API_HOST',
    description:
      'Address the API server binds. Default: all interfaces (what a container platform such as Cloud Run needs). `127.0.0.1` keeps it off the network; `kindgi dev` sets that on Linux, where the runtime container shares the host network.',
    example: '127.0.0.1',
    required: false,
    appliesTo: appliesToServer,
    group: 'core',
  },
  {
    name: 'KINDGI_DATABASE_URL',
    description:
      'Postgres connection string. Default `postgres://localhost:5432/kindgi` (dev only).',
    example: 'postgres://user:pass@postgres.internal:5432/kindgi',
    required: false,
    appliesTo: appliesToServer,
    group: 'core',
  },
  {
    name: 'KINDGI_OPENFGA_API_URL',
    description:
      'OpenFGA HTTP API URL. Set → per-tenant FGA stores are bootstrapped and authorization is enforced; unset → routes mount without enforcement (dev only; production MUST set it).',
    example: 'http://openfga.internal:8080',
    required: false,
    appliesTo: appliesToServer,
    group: 'core',
  },
  {
    name: 'KINDGI_TENANT_ID',
    description: 'Tenant UUID to seed / reuse. Default: fresh UUID printed at boot.',
    example: '00000000-0000-4000-8000-000000000001',
    required: false,
    appliesTo: appliesToServer,
    group: 'core',
  },
  {
    name: 'KINDGI_API_TOKEN',
    description: 'Bearer token to seed / reuse. Default: fresh `kgi_bt_...` token per boot.',
    example: 'kgi_bt_my_stable_local_token',
    required: false,
    appliesTo: appliesToServer,
    group: 'core',
  },
  {
    name: 'KINDGI_SEED_USER_ID',
    description:
      'Seed user UUID. Pinning this across restarts keeps the FGA admin@tenant tuple stable.',
    example: '00000000-0000-4000-8000-000000000002',
    required: false,
    appliesTo: appliesToServer,
    group: 'core',
  },
  {
    name: 'KINDGI_DOCS',
    description: 'Mount `/docs` (Scalar API reference). `true` (default) | `false`.',
    example: 'true',
    required: false,
    appliesTo: appliesToServer,
    group: 'core',
    allowedValues: ['true', 'false', '1', '0'],
  },
  {
    name: 'KINDGI_DEV',
    description:
      'Development mode: `true` enables development-only settings (the `dotenv` secrets backend, `KINDGI_PACK_DIR`, `KINDGI_DEV_CONSOLE_LOGIN`, `KINDGI_DEV_HOST_ALIAS`). The server refuses those settings when this is off. Never set it in production.',
    example: 'false',
    required: false,
    appliesTo: appliesToServer,
    group: 'core',
    allowedValues: ['true', 'false', '1', '0'],
  },
  {
    name: 'KINDGI_TENANT_HOST_ACCESS',
    description:
      "How far what tenants register may reach into the server's own host. `deployed` refuses a `stdio` MCP endpoint (a command the server would run in its container, as its user) at registration (`403 host-access-denied`) and at connect; run MCP servers over HTTP instead. It also refuses the server's connections to the cloud metadata endpoints (link-local addresses) and to its own host (loopback) when a tenant chose the host: an MCP endpoint, a model provider's base URL, an HTTP tool, an image reference. Private networks stay reachable. `local` allows all of it: only for a machine where every token holder may run commands. Unset: `local` with `KINDGI_DEV`, `deployed` otherwise; a value set here always wins.",
    example: 'deployed',
    required: false,
    appliesTo: appliesToServer,
    group: 'core',
    allowedValues: ['local', 'deployed'],
  },
  {
    name: 'KINDGI_LICENSE_KEY',
    description:
      'The commercial license key (`kgi_lk_...`) Kindgi issues: signed, checked offline at startup, with no call to Kindgi. Required outside development mode: without a valid key the server refuses to start, naming this variable. `KINDGI_DEV=true` needs none. A production key comes with a commercial license; a free non-production key covers staging and CI. A secret: give it from your secrets store.',
    example: '',
    required: false,
    appliesTo: appliesToServer,
    group: 'core',
  },
  {
    name: 'KINDGI_ENV',
    description:
      'The env this runtime serves. Secrets a tool declares by name (`needsSpec.secrets`) resolve under this env name. Unset: `local` in development mode (the `.env` and `.env.local` files); otherwise a tool that declares secrets fails its calls, naming this variable.',
    example: 'production',
    required: false,
    appliesTo: appliesToServer,
    group: 'core',
  },
  {
    name: 'KINDGI_PUBLIC_TOKEN_SIGNING_KEY_PATH',
    description:
      'Absolute path to the Ed25519 private key (PKCS#8 PEM, mode 0600) that signs public run tokens (`kgi_pt_…`): the short-lived, read-only tokens a browser uses to follow a run. Use a key for this alone (`openssl genpkey -algorithm ed25519`). Unset: in development mode the server signs with a key generated at startup (tokens end at restart); otherwise public run tokens are off.',
    example: '/etc/kindgi/public-token-signing.pem',
    required: false,
    appliesTo: appliesToServer,
    group: 'core',
  },
  {
    name: 'KINDGI_PUBLIC_TOKEN_SIGNING_KEY',
    description:
      "The same key's PEM file, base64 (`base64 < key.pem`): for platforms that give secrets as environment variables (Cloud Run with Secret Manager), where a key file's mode can't be 0600. Set this or `KINDGI_PUBLIC_TOKEN_SIGNING_KEY_PATH`, not both.",
    example: '',
    required: false,
    appliesTo: appliesToServer,
    group: 'core',
  },
  {
    name: 'KINDGI_CORS_ORIGINS',
    description:
      'Comma-separated browser origins allowed to call, cross-origin, the routes a public run token can use (`GET /v1/runs/{runId}/progress` and its stream). Exact origins, no wildcards. Unset: no CORS headers on any route.',
    example: 'https://app.example.com',
    required: false,
    appliesTo: appliesToServer,
    group: 'core',
  },

  // ---- secrets backend --------------------------------------------
  {
    name: 'KINDGI_SECRETS_BACKEND',
    description:
      'Where secret bytes live. `none` (default; /v1/secrets/* unmounted) | `postgres` (envelope-encrypted, needs KMS) | `dotenv` (`.env` files in a directory; development only, needs `KINDGI_DEV=true`) | `secret-manager` (reserved; not supported through this variable).',
    example: 'postgres',
    required: false,
    appliesTo: appliesToServer,
    group: 'secrets',
    allowedValues: ['none', 'postgres', 'dotenv', 'secret-manager'],
  },
  {
    name: 'KINDGI_SECRETS_DOTENV_DIR',
    description:
      'Absolute path of the directory whose `.env` files hold secrets (`dotenv` backend). Mount the project directory here; secrets written through the API land in its files.',
    example: '/pack',
    required: true,
    appliesTo: appliesToDotenvBackend,
    group: 'secrets',
  },
  {
    name: 'KINDGI_SECRETS_DOTENV_FILES',
    description:
      'Comma-separated `.env` files read for secrets (`dotenv` backend), relative to `KINDGI_SECRETS_DOTENV_DIR`, lowest precedence first. Default `.env,.env.local`.',
    example: '.env,.env.local',
    required: false,
    appliesTo: appliesToDotenvBackend,
    group: 'secrets',
  },
  {
    name: 'KINDGI_SECRETS_BACKEND_KMS',
    description:
      'Which KMS vendor wraps DEKs (postgres backend only). Currently supported: `gcp`. Reserved: `aws`, `libsodium`.',
    example: 'gcp',
    required: true,
    appliesTo: appliesToPostgresBackend,
    group: 'secrets',
    allowedValues: ['gcp', 'aws', 'libsodium'],
  },
  {
    name: 'KINDGI_SECRETS_AAD_KEY_PATH',
    description:
      'Absolute path to a 32-byte AAD/HMAC key file (mode 0600). Same key across every replica; protects AEAD associated data over every secret row. The postgres backend needs this or `KINDGI_SECRETS_AAD_KEY`, not both.',
    example: '/etc/kindgi/secrets-aad.key',
    required: false,
    appliesTo: appliesToPostgresBackend,
    group: 'secrets',
  },
  {
    name: 'KINDGI_SECRETS_AAD_KEY',
    description:
      "The 32-byte AAD/HMAC key itself, base64: for platforms that give secrets as environment variables (Cloud Run with Secret Manager), where a key file's mode can't be 0600. The postgres backend needs this or `KINDGI_SECRETS_AAD_KEY_PATH`, not both.",
    example: '',
    required: false,
    appliesTo: appliesToPostgresBackend,
    group: 'secrets',
  },

  // ---- GCP vendor -------------------------------------------------
  {
    name: 'KINDGI_SECRETS_GCP_PROJECT_ID',
    description: 'GCP project id owning the KMS keyring + key.',
    example: 'my-proj',
    required: true,
    appliesTo: appliesToPostgresGcp,
    group: 'gcp',
  },
  {
    name: 'KINDGI_SECRETS_GCP_LOCATION_ID',
    description: 'KMS location, e.g. `us-central1`, `europe-west1`, `global`.',
    example: 'us-central1',
    required: true,
    appliesTo: appliesToPostgresGcp,
    group: 'gcp',
  },
  {
    name: 'KINDGI_SECRETS_GCP_KEY_RING_ID',
    description: 'KMS keyring id within the location.',
    example: 'kindgi',
    required: true,
    appliesTo: appliesToPostgresGcp,
    group: 'gcp',
  },
  {
    name: 'KINDGI_SECRETS_GCP_KEY_ID',
    description: 'CryptoKey id within the keyring (symmetric GOOGLE_SYMMETRIC_ENCRYPTION).',
    example: 'secrets-kek',
    required: true,
    appliesTo: appliesToPostgresGcp,
    group: 'gcp',
  },

  // ---- pack service -----------------------------------------------
  // The server's side: where the pack service is, and how long a call
  // may take.
  {
    name: 'KINDGI_PACK_SERVICE_URL',
    description:
      'Base URL of the pack service, the separate process that runs the pack code (its tools and guardrail checks), e.g. `http://pack-service:8080` or its internal Cloud Run URL. Set: the server calls it over HTTP for every pack tool and check, and needs `KINDGI_PACK_SERVICE_TOKEN`. Unset: no pack code runs, and a pack tool fails saying no pack service is wired. `kindgi dev` runs its own.',
    example: 'http://pack-service:8080',
    required: false,
    appliesTo: appliesToServer,
    group: 'pack-service',
  },
  {
    name: 'KINDGI_PACK_CALL_TIMEOUT_MS',
    description:
      'How long one pack call (a tool or a guardrail check) may take, in milliseconds. Default 120000. The deadline travels with the call, and the pack service aborts the handler when it passes.',
    example: '120000',
    required: false,
    appliesTo: appliesToServerHttpPackTransport,
    group: 'pack-service',
  },
  {
    name: 'KINDGI_PACK_SERVICE_AUTH',
    description:
      "How the server proves itself to the pack service besides the pack token. `token` (default): the pack token alone. `google-id-token`: also a Google ID token for the pack service URL, from the server's own identity, for a pack service on Cloud Run behind IAM (`--no-allow-unauthenticated`); the URL must be https. The identity is a service account: on Cloud Run the server's own; elsewhere, impersonate one (a person's own credentials can't mint an ID token for a service).",
    example: 'token',
    required: false,
    appliesTo: appliesToServerHttpPackTransport,
    group: 'pack-service',
    allowedValues: ['token', 'google-id-token'],
  },
  // Both sides: the shared token.
  {
    name: 'KINDGI_PACK_SERVICE_TOKEN',
    description:
      'Shared secret between the server and the pack service. The pack service refuses any call without it, and the server sends it with every call. Required by the pack service, and by the server when `KINDGI_PACK_SERVICE_URL` is set. Use a long random value (`openssl rand -base64 32`). The pack service removes it from its environment before it loads the pack code.',
    example: '',
    required: true,
    appliesTo: (t) => appliesToPackService(t) || appliesToServerHttpPackTransport(t),
    group: 'pack-service',
  },
  // The pack service's side. It also listens on `PORT` (default 8080),
  // the platform convention, which is not a Kindgi variable.
  {
    name: 'KINDGI_PACK_INDEX',
    description:
      "Path of the pack's `index.json` in the pack service's image. Default `/app/index.json`, where `kindgi build` puts it; the `--index` flag overrides it.",
    example: '/app/index.json',
    required: false,
    appliesTo: appliesToPackService,
    group: 'pack-service',
  },
  {
    name: 'KINDGI_PACK_SERVICE_MAX_CONCURRENCY',
    description:
      "How many calls the pack service runs at once. Past it, calls get 503 (`overloaded`), which the server retries. Default 32. On Cloud Run, set the service's concurrency to the same number.",
    example: '32',
    required: false,
    appliesTo: appliesToPackService,
    group: 'pack-service',
  },
  {
    name: 'KINDGI_PACK_ENV_CHECK',
    description:
      "What the pack service does when a name the pack's `env.required` declares is unset or empty in its environment. `strict` (default): it isn't ready, and `/readyz` and every call answer 503 naming the missing names. `warn`: it serves, and names them in its log and `/v1/info`. `kindgi dev` uses `warn`.",
    example: 'strict',
    required: false,
    appliesTo: appliesToPackService,
    group: 'pack-service',
    allowedValues: ['strict', 'warn'],
  },

  // ---- image registry ---------------------------------------------
  // How the server reads a deployment's image to verify it (`POST
  // /v1/deployments`): anonymous unless credentials are set.
  {
    name: 'KINDGI_IMAGE_REGISTRY_HOST',
    description:
      'The registry host the credentials below are for, with its port when it has one (e.g. `registry.example`, `ghcr.io`). Other registries are read anonymously.',
    example: 'registry.example',
    required: false,
    appliesTo: appliesToServer,
    group: 'image-registry',
  },
  {
    name: 'KINDGI_IMAGE_REGISTRY_USERNAME',
    description:
      "Username for `KINDGI_IMAGE_REGISTRY_HOST`. Used for the registry's token flow, or as basic auth.",
    example: 'kindgi-reader',
    required: false,
    appliesTo: appliesToServer,
    group: 'image-registry',
  },
  {
    name: 'KINDGI_IMAGE_REGISTRY_PASSWORD',
    description:
      'Password or access token for `KINDGI_IMAGE_REGISTRY_HOST`. Read-only (pull) access is enough.',
    example: '',
    required: false,
    appliesTo: appliesToServer,
    group: 'image-registry',
  },
  {
    name: 'KINDGI_IMAGE_REGISTRY_INSECURE_HOSTS',
    description:
      'Comma-separated registry hosts reached over plain HTTP instead of HTTPS, e.g. a local `registry:2`. Loopback hosts (`localhost`, `127.0.0.1`) always are.',
    example: 'registry.internal:5000',
    required: false,
    appliesTo: appliesToServer,
    group: 'image-registry',
  },
  {
    name: 'KINDGI_IMAGE_REGISTRY_AUTH',
    description:
      "How the server signs in to `KINDGI_IMAGE_REGISTRY_HOST`. `static` (default): `KINDGI_IMAGE_REGISTRY_USERNAME` and `_PASSWORD`. `google`: the server's own Google identity (Application Default Credentials: the service's identity on Cloud Run), for Artifact Registry; no username or password is set, and Kindgi keeps no key file.",
    example: 'static',
    required: false,
    appliesTo: appliesToServer,
    group: 'image-registry',
    allowedValues: ['static', 'google'],
  },

  // ---- development (`kindgi dev`) ---------------------------------
  {
    name: 'KINDGI_PACK_DIR',
    description:
      "Development only: the pack directory `kindgi dev` runs. The server reads the pack's tools, guardrails, agents and flows from the index `kindgi dev` writes there (`.kindgi/dev/index.json`), on every change, instead of from Postgres; signed deployments are off. Mount the directory, not the file: the index is replaced by rename.",
    example: '/pack',
    required: false,
    appliesTo: appliesToServer,
    group: 'dev',
  },
  {
    name: 'KINDGI_DEV_CONSOLE_LOGIN',
    description:
      'Development only: `true` lets the console log in by itself. `GET /__dev/bearer` hands it the API token, answering only requests addressed to a loopback host (`localhost`, `127.0.0.1`, `[::1]`). Needs the console.',
    example: 'true',
    required: false,
    appliesTo: appliesToServer,
    group: 'dev',
    allowedValues: ['true', 'false', '1', '0'],
  },
  {
    name: 'KINDGI_DEV_HOST_ALIAS',
    description:
      "Development only: where the server's outbound calls to a loopback address (`localhost`, `127.0.0.1`, `[::1]`) connect instead. This covers webhooks to the app, HTTP MCP endpoints, model providers and the pack service. Inside a container, loopback is the container itself; `kindgi dev` sets `host.docker.internal` on Docker Desktop. The URL, the `Host` header and the TLS server name stay as written; only the connection goes to the alias.",
    example: 'host.docker.internal',
    required: false,
    appliesTo: appliesToServer,
    group: 'dev',
  },
];

// ---------------------------------------------------------------------
// Helper API — the three consumer entry points.
// ---------------------------------------------------------------------

/**
 * Filter the schema down to just vars that apply to the caller's
 * target. Preserves declaration order (which drives `.env.example`
 * ordering).
 */
export function envVarsForTarget(
  target: EnvTarget,
  schema: readonly EnvVarSpec[] = KINDGI_ENV_SCHEMA,
): readonly EnvVarSpec[] {
  return schema.filter((v) => v.appliesTo(target));
}

/**
 * Render vars as a `.env.example` file body. Each group listed in
 * `ENV_GROUPS` gets a section-header comment; groups appear in order of
 * first appearance, ungrouped vars last. Each var gets a description
 * comment, its allowed-values enum (when set), and the example
 * assignment. Optional vars are prefixed with `# ` so operators
 * explicitly opt in.
 */
export function renderEnvExample(vars: readonly EnvVarSpec[]): string {
  const groups = new Map<string, EnvVarSpec[]>();
  const ungrouped: EnvVarSpec[] = [];
  for (const v of vars) {
    if (v.group === undefined) {
      ungrouped.push(v);
      continue;
    }
    const list = groups.get(v.group);
    if (list !== undefined) {
      list.push(v);
    } else {
      groups.set(v.group, [v]);
    }
  }

  const lines: string[] = [
    '# Generated by `kindgi env init` — Kindgi deployment env vars.',
    '# See @kindgi/env-schema for the source of truth.',
    '',
  ];

  const emitGroup = (group: string | undefined, entries: readonly EnvVarSpec[]): void => {
    if (entries.length === 0) return;
    const header = group !== undefined && ENV_GROUPS[group as keyof typeof ENV_GROUPS];
    if (typeof header === 'string') {
      lines.push(`# ---- ${header} ----`);
      lines.push('');
    }
    for (const v of entries) {
      lines.push(`# ${v.description}`);
      if (v.allowedValues !== undefined) {
        lines.push(`# Allowed values: ${v.allowedValues.join(' | ')}`);
      }
      const prefix = v.required ? '' : '# ';
      lines.push(`${prefix}${v.name}=${v.example}`);
      lines.push('');
    }
  };

  for (const [group, entries] of groups) {
    emitGroup(group, entries);
  }
  emitGroup(undefined, ungrouped);

  return lines.join('\n');
}

/**
 * Check whether every required var for the target is set in `env`.
 * Returns `{ ok: true }` on success, `{ ok: false, missing }` with a
 * complete list of missing var names on failure. Callers can render
 * this into an operator-actionable error message.
 *
 * Only checks REQUIRED vars — optional vars that are unset are fine
 * (defaults apply, or the var is passthrough).
 *
 * Does not enforce `allowedValues` — that's a declarative hint for
 * tooling; code that reads a var validates its value.
 */
export function validateEnvForTarget(
  env: Readonly<Record<string, string | undefined>>,
  target: EnvTarget,
  schema: readonly EnvVarSpec[] = KINDGI_ENV_SCHEMA,
): { readonly ok: true } | { readonly ok: false; readonly missing: readonly string[] } {
  const applicable = envVarsForTarget(target, schema);
  const missing: string[] = [];
  for (const v of applicable) {
    if (!v.required) continue;
    const value = env[v.name];
    if (value === undefined || value === '') {
      missing.push(v.name);
    }
  }
  if (missing.length === 0) return { ok: true };
  return { ok: false, missing };
}
