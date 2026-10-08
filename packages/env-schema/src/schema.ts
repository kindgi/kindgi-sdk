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
  logging: 'Logging',
  secrets: 'Secrets backend selection',
  gcp: 'GCP vendor config (postgres + gcp KMS)',
  'local-key': 'Local key (postgres + libsodium: a key this runtime holds, single-node)',
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

const appliesToPostgresLocalKey = (t: EnvTarget): boolean =>
  appliesToPostgresBackend(t) && t.secretsBackendKms === 'libsodium';

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
    description:
      "HTTP port the Kindgi API server listens on. The first that's set wins: the `--port` flag, `KINDGI_API_PORT`, the platform's `PORT` (Cloud Run, Render, Heroku and Fly set it and send traffic only there), the config file's `port`, then 4000.",
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
    name: 'KINDGI_PUBLIC_URL',
    description:
      "The URL clients reach the API server at, when it isn't the address the server binds: behind a proxy or a load balancer, or in a container whose port is published on another one (`kindgi dev` sets it). The startup banner names it, with the docs and console links. An http(s) URL with no query or fragment. Default: the address the server binds.",
    example: 'https://kindgi.example.com',
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
    name: 'KINDGI_WEBHOOK_PRIVATE_NETWORKS',
    description:
      'Whether a webhook may go to a private network address: for a receiver on the same VPC or compose network as a self-hosted server. `allow` accepts a receiver whose host resolves to a private address: RFC 1918, CGNAT (100.64.0.0/10) or IPv6 unique-local. Loopback, link-local (the cloud metadata endpoints) and unroutable addresses stay refused, and webhooks stay https only. Unset or `deny`: public addresses only. Development mode (`KINDGI_DEV`) allows http and every address anyway.',
    example: 'allow',
    required: false,
    appliesTo: appliesToServer,
    group: 'core',
    allowedValues: ['allow', 'deny'],
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
      'The env this runtime serves. The secrets and env values a tool declares by name (`needsSpec.secrets`, `needsSpec.env`) resolve under this env name. Unset: `local` in development mode (secrets from the `.env` and `.env.local` files, env values from `/v1/env`); otherwise a tool that declares either fails its calls, naming this variable.',
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
    name: 'KINDGI_AUTH_SECRET_PATH',
    description:
      'Turns on sign-in with identity providers (OIDC, SAML): absolute path to a 32-byte random key (mode 0600) the browser sign-in flow signs its state with (`openssl rand 32 > auth-secret`). Needs `KINDGI_PUBLIC_URL`: identity providers send people back there. Unset (with `KINDGI_AUTH_SECRET` unset too): sign-in is off, and the API takes only API keys.',
    example: '/etc/kindgi/auth-secret',
    required: false,
    appliesTo: appliesToServer,
    group: 'core',
  },
  {
    name: 'KINDGI_AUTH_SECRET',
    description:
      "The same key, base64 (`base64 < auth-secret`): for platforms that give secrets as environment variables (Cloud Run with Secret Manager), where a key file's mode can't be 0600. Set this or `KINDGI_AUTH_SECRET_PATH`, not both.",
    example: '',
    required: false,
    appliesTo: appliesToServer,
    group: 'core',
  },
  {
    name: 'KINDGI_AUTH_PRIVATE_IDP_ORIGINS',
    description:
      "Comma-separated origins of identity providers on a private network (a self-hosted Keycloak or AD FS behind a VPN, e.g. `https://sso.corp.internal`) that tenants may register. Only public HTTPS identity providers are allowed otherwise: a tenant admin can't point the runtime at the deployment's own network.",
    example: 'https://sso.corp.internal',
    required: false,
    appliesTo: appliesToServer,
    group: 'core',
  },
  {
    name: 'KINDGI_AUTH_VERIFIED_DOMAINS',
    description:
      "Comma-separated `domain:tenant` pairs (the tenant by id, or by a unique slug): email domains whose sign-in routes to that tenant's identity providers. A runtime that serves one tenant routes that tenant's domains without this. One that serves several routes a domain only once it's listed here: otherwise a tenant could list another company's domain and catch its people. An unlisted domain's people can still use their provider's own sign-in link (`kindgi sso providers test` prints it). A malformed entry, or a tenant this runtime doesn't serve, stops the runtime at start.",
    example: 'acme.com:3f8e2c1a-0b7d-4e9a-9c5f-2d1e6b8a7c40',
    required: false,
    appliesTo: appliesToServer,
    group: 'core',
  },
  {
    name: 'KINDGI_AUTH_GOOGLE_CLIENT_ID',
    description:
      "Turns on \"Continue with Google\": the client id of the deployment's own Google app (an OAuth client (Web application)). People who've been added to a workspace sign in with their Google account, by its verified email. The app allows the redirect URI `<KINDGI_PUBLIC_URL>/auth/kindgi/social/callback/google`. Needs sign-in on (`KINDGI_AUTH_SECRET_PATH`) and the app's secret (`KINDGI_AUTH_GOOGLE_CLIENT_SECRET` or `…_SECRET_PATH`).",
    example: '',
    required: false,
    appliesTo: appliesToServer,
    group: 'core',
  },
  {
    name: 'KINDGI_AUTH_GOOGLE_CLIENT_SECRET',
    description:
      "The Google app's client secret, for platforms that give secrets as environment variables. Set this or `KINDGI_AUTH_GOOGLE_CLIENT_SECRET_PATH`, not both.",
    example: '',
    required: false,
    appliesTo: appliesToServer,
    group: 'core',
  },
  {
    name: 'KINDGI_AUTH_GOOGLE_CLIENT_SECRET_PATH',
    description:
      "A file (mode 0600) holding the Google app's client secret. Set this or `KINDGI_AUTH_GOOGLE_CLIENT_SECRET`, not both.",
    example: '/etc/kindgi/google-client-secret',
    required: false,
    appliesTo: appliesToServer,
    group: 'core',
  },
  {
    name: 'KINDGI_AUTH_MICROSOFT_CLIENT_ID',
    description:
      "Turns on \"Continue with Microsoft\": the client id of the deployment's own Microsoft app (an app registration (multitenant, with the ID-token optional claims `email` and `xms_edov`)). People who've been added to a workspace sign in with their Microsoft account, by its verified email. The app allows the redirect URI `<KINDGI_PUBLIC_URL>/auth/kindgi/social/callback/microsoft`. Needs sign-in on (`KINDGI_AUTH_SECRET_PATH`) and the app's secret (`KINDGI_AUTH_MICROSOFT_CLIENT_SECRET` or `…_SECRET_PATH`).",
    example: '',
    required: false,
    appliesTo: appliesToServer,
    group: 'core',
  },
  {
    name: 'KINDGI_AUTH_MICROSOFT_CLIENT_SECRET',
    description:
      "The Microsoft app's client secret, for platforms that give secrets as environment variables. Set this or `KINDGI_AUTH_MICROSOFT_CLIENT_SECRET_PATH`, not both.",
    example: '',
    required: false,
    appliesTo: appliesToServer,
    group: 'core',
  },
  {
    name: 'KINDGI_AUTH_MICROSOFT_CLIENT_SECRET_PATH',
    description:
      "A file (mode 0600) holding the Microsoft app's client secret. Set this or `KINDGI_AUTH_MICROSOFT_CLIENT_SECRET`, not both.",
    example: '/etc/kindgi/microsoft-client-secret',
    required: false,
    appliesTo: appliesToServer,
    group: 'core',
  },
  {
    name: 'KINDGI_AUTH_GITHUB_CLIENT_ID',
    description:
      "Turns on \"Continue with GitHub\": the client id of the deployment's own GitHub app (an OAuth App). People who've been added to a workspace sign in with their GitHub account, by its verified email. The app allows the redirect URI `<KINDGI_PUBLIC_URL>/auth/kindgi/social/callback/github`. Needs sign-in on (`KINDGI_AUTH_SECRET_PATH`) and the app's secret (`KINDGI_AUTH_GITHUB_CLIENT_SECRET` or `…_SECRET_PATH`).",
    example: '',
    required: false,
    appliesTo: appliesToServer,
    group: 'core',
  },
  {
    name: 'KINDGI_AUTH_GITHUB_CLIENT_SECRET',
    description:
      "The GitHub app's client secret, for platforms that give secrets as environment variables. Set this or `KINDGI_AUTH_GITHUB_CLIENT_SECRET_PATH`, not both.",
    example: '',
    required: false,
    appliesTo: appliesToServer,
    group: 'core',
  },
  {
    name: 'KINDGI_AUTH_GITHUB_CLIENT_SECRET_PATH',
    description:
      "A file (mode 0600) holding the GitHub app's client secret. Set this or `KINDGI_AUTH_GITHUB_CLIENT_SECRET`, not both.",
    example: '/etc/kindgi/github-client-secret',
    required: false,
    appliesTo: appliesToServer,
    group: 'core',
  },
  {
    name: 'KINDGI_AUTH_EMAIL_SMTP_URL',
    description:
      "Turns on the emailed sign-in link: people who've been added to a workspace can ask for a one-time link (ten minutes) by email. The SMTP server to send it through, with its credentials: `smtps://user:password@smtp.example.com:465`. Any provider works (Resend, Postmark, Amazon SES, your own relay). Needs sign-in on (`KINDGI_AUTH_SECRET_PATH`) and `KINDGI_AUTH_EMAIL_FROM`. Set this or `KINDGI_AUTH_EMAIL_SMTP_URL_PATH`, not both.",
    example: '',
    required: false,
    appliesTo: appliesToServer,
    group: 'core',
  },
  {
    name: 'KINDGI_AUTH_EMAIL_SMTP_URL_PATH',
    description:
      'A file (mode 0600) holding the SMTP URL with its credentials. Set this or `KINDGI_AUTH_EMAIL_SMTP_URL`, not both.',
    example: '/etc/kindgi/smtp-url',
    required: false,
    appliesTo: appliesToServer,
    group: 'core',
  },
  {
    name: 'KINDGI_AUTH_EMAIL_FROM',
    description:
      "The emailed sign-in link's From address, on a domain your SMTP provider may send for (SPF and DKIM set up): `Kindgi <sign-in@acme.com>`.",
    example: 'Kindgi <sign-in@acme.com>',
    required: false,
    appliesTo: appliesToServer,
    group: 'core',
  },
  {
    name: 'KINDGI_AUTH_EMAIL_LINK_DAILY_CAP',
    description:
      'At most this many emailed sign-in links to one address in 24 hours, whoever asks for them (rotating client addresses gets past the per-client limit). Default 10. At the cap the request answers as usual, and nothing is sent.',
    example: '10',
    required: false,
    appliesTo: appliesToServer,
    group: 'core',
  },
  {
    name: 'KINDGI_AUTH_TURNSTILE_SECRET',
    description:
      "A Cloudflare Turnstile secret key: asking for an emailed link then needs the widget's token, checked with Cloudflare. Required when the runtime serves several tenants. Without it (one tenant), the link is still sent only to people who can sign in, at most one per address a minute and the daily cap a day, and requests are rate-limited per client. Set this or `KINDGI_AUTH_TURNSTILE_SECRET_PATH`, not both, with `KINDGI_AUTH_TURNSTILE_SITE_KEY`.",
    example: '',
    required: false,
    appliesTo: appliesToServer,
    group: 'core',
  },
  {
    name: 'KINDGI_AUTH_TURNSTILE_SECRET_PATH',
    description:
      'A file (mode 0600) holding the Turnstile secret key. Set this or `KINDGI_AUTH_TURNSTILE_SECRET`, not both.',
    example: '/etc/kindgi/turnstile-secret',
    required: false,
    appliesTo: appliesToServer,
    group: 'core',
  },
  {
    name: 'KINDGI_AUTH_TURNSTILE_SITE_KEY',
    description:
      'The Turnstile site key the sign-in page shows the widget with (public). Set with the secret.',
    example: '',
    required: false,
    appliesTo: appliesToServer,
    group: 'core',
  },
  {
    name: 'KINDGI_TRUSTED_PROXIES',
    description:
      "Which proxies in front of the runtime to trust for the client's address, which rate limits and audit records use. Unset: the connection's peer, and `X-Forwarded-For` is ignored (anyone can send it). A hop count (`1` behind one proxy such as a cloud load balancer or ingress, `2` behind two) or comma-separated IPs/CIDR ranges of your proxies: the client is the first `X-Forwarded-For` hop, from the right, that isn't one of them; never the leftmost on its own. Behind a proxy without this, every client counts as the proxy, so rate limits are shared by everyone.",
    example: '1',
    required: false,
    appliesTo: appliesToServer,
    group: 'core',
  },
  {
    name: 'KINDGI_SESSION_TTL_MS',
    description:
      "A browser session's absolute lifetime, in milliseconds: the person signs in again after it. Default 43200000 (12 hours); at least 60000.",
    example: '43200000',
    required: false,
    appliesTo: appliesToServer,
    group: 'core',
  },
  {
    name: 'KINDGI_SESSION_IDLE_TIMEOUT_MS',
    description:
      'How long a browser session may sit idle before it ends, in milliseconds. Default 3600000 (60 minutes); at least 60000, and no longer than `KINDGI_SESSION_TTL_MS`.',
    example: '3600000',
    required: false,
    appliesTo: appliesToServer,
    group: 'core',
  },
  {
    name: 'KINDGI_CONSOLE_TOKEN_SIGN_IN',
    description:
      "Whether a person may sign in to the console with an API token: `on` or `off`. Default `off`, and `on` in local development (`kindgi dev`). The token is exchanged once for a browser session (the same cookie as sign-in with an identity provider) and never kept in the browser. Only a person's full key opens a session, never a service account's or a narrowed key. API tokens work for the API, CLI and SDKs either way. Set `on` to keep signing in to the console by pasting a token when it has no identity provider.",
    example: 'on',
    required: false,
    appliesTo: appliesToServer,
    group: 'core',
  },
  {
    name: 'KINDGI_EXPORT_SIGNING_KEY_PATH',
    description:
      'Absolute path to the private key (PKCS#8 PEM, mode 0600) that signs exports: approval audit bundles, run provenance and compliance evidence. An Ed25519 key signs `ed25519` (`openssl genpkey -algorithm ed25519`); an EC P-256 key signs `ecdsa-p256-sha256`. Use a key for this alone; `GET /v1/export-signing-keys` publishes its public half. Set one of this, `KINDGI_EXPORT_SIGNING_KEY` or `KINDGI_EXPORT_SIGNING_KMS_KEY`. None: in development mode the server signs with a key generated at startup; otherwise exports answer `404 signing-not-configured`.',
    example: '/etc/kindgi/export-signing.pem',
    required: false,
    appliesTo: appliesToServer,
    group: 'core',
  },
  {
    name: 'KINDGI_EXPORT_SIGNING_KEY',
    description:
      "The same key's PEM file, base64 (`base64 < key.pem`): for platforms that give secrets as environment variables, such as Cloud Run with Secret Manager. A production path in its own right.",
    example: '',
    required: false,
    appliesTo: appliesToServer,
    group: 'core',
  },
  {
    name: 'KINDGI_EXPORT_SIGNING_KMS_KEY',
    description:
      "Optional: a Cloud KMS key version that signs exports, so the private key never leaves KMS: `projects/<p>/locations/<l>/keyRings/<r>/cryptoKeys/<k>/cryptoKeyVersions/<n>`. It must be an `EC_SIGN_ED25519` key (it signs `ed25519`) or an `EC_SIGN_P256_SHA256` key (`ecdsa-p256-sha256`), and the server's service account needs `roles/cloudkms.signerVerifier` on it (and `roles/cloudkms.publicKeyViewer`, to read its public key at boot).",
    example:
      'projects/acme/locations/global/keyRings/kindgi/cryptoKeys/exports/cryptoKeyVersions/1',
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
  {
    name: 'KINDGI_RUN_LEASE_MS',
    description:
      "How long a run's executor lease lasts without renewal, in milliseconds. Every unfinished run and every running eval run holds one, renewed every quarter of this by the server executing it. When a server stops without a shutdown (killed, out of memory, a crash), their leases run out, and a server's sweep fails them: a run sending `run.finished`, an eval run ending `failed`, interrupted, with its finished cases kept. Default 300000 (5 minutes); at least 10000, or the server refuses to start. A shorter lease finds such runs sooner, at the cost of more renewals.",
    example: '300000',
    required: false,
    appliesTo: appliesToServer,
    group: 'core',
  },
  {
    name: 'KINDGI_RUN_SWEEP_INTERVAL_MS',
    description:
      'How often each server sweeps for runs and eval runs whose executor lease ran out, in milliseconds. A run or eval run whose server stopped without a shutdown is failed within about `KINDGI_RUN_LEASE_MS` plus this. Default 60000; at least 1000, and shorter than `KINDGI_RUN_LEASE_MS`, or the server refuses to start.',
    example: '60000',
    required: false,
    appliesTo: appliesToServer,
    group: 'core',
  },
  {
    name: 'KINDGI_RETENTION_SWEEP_INTERVAL_MS',
    description:
      "How often the server purges deleted rows on its own, in milliseconds: in every tenant it serves, it purges for good the tombstones past their retention policy's grace, as `POST /v1/retention/sweep` does, holds (`graceSeconds: -1`) kept, and logs what it purged. Unset (the default): nothing purges on its own; sweep with `POST /v1/retention/sweep` or the console. At least 60000, or the server refuses to start.",
    example: '3600000',
    required: false,
    appliesTo: appliesToServer,
    group: 'core',
  },
  {
    name: 'KINDGI_COMPLIANCE_CLASSIFIER',
    description:
      "Turns on the audit trail's compliance features: `shipped` uses the classifier the runtime ships; or give the absolute path of your own classifier JSON. When set, the server serves `/v1/compliance/*` (audit events as compliance evidence, and their signed export) and **purges audit events by kind, as the classifier says**. With `shipped`: authorization decisions after 90 days (denials after 365), run outcomes and guardrail violations after 730 days; secret changes and approval decisions are kept (legal hold), and so are kinds the classifier doesn't list. Unset (the default): no `/v1/compliance/*`, and no audit event is ever purged.",
    example: 'shipped',
    required: false,
    appliesTo: appliesToServer,
    group: 'core',
  },
  {
    name: 'KINDGI_ARTIFACTS',
    description:
      "Where artifacts' files go, which turns on `/v1/artifacts`: `local:<absolute dir>` (a directory on this machine) or `gcs:<bucket>[/<prefix>]` (a Google Cloud Storage bucket, through Application Default Credentials: workload identity on GCP, no keys to store). Metadata is in Postgres; a deleted artifact is purged under the `artifact` retention policy. Unset (the default): no `/v1/artifacts`. `kindgi dev` sets it to the pack's `.kindgi/dev/artifacts`.",
    example: 'gcs:acme-artifacts/prod',
    required: false,
    appliesTo: appliesToServer,
    group: 'core',
  },
  {
    name: 'KINDGI_ARTIFACT_MAX_BYTES',
    description:
      'The most bytes one artifact upload may carry, the whole request body; more is `413 artifact-too-large`. Default 104857600 (100 MB).',
    example: '104857600',
    required: false,
    appliesTo: appliesToServer,
    group: 'core',
  },
  {
    name: 'KINDGI_LOG_LEVEL',
    description:
      'The lowest level written: `error`, `warn`, `info` (default), `debug` or `trace`. At `info` an idle runtime writes nothing after its boot record but background work that did something. An unknown level stops the server at boot, naming this variable (exit code 2).',
    example: 'info',
    required: false,
    // The runtime server's; the pack service doesn't read it yet.
    appliesTo: appliesToServer,
    group: 'logging',
    allowedValues: ['error', 'warn', 'info', 'debug', 'trace'],
  },
  {
    name: 'KINDGI_LOG_LEVELS',
    description:
      "Levels per subsystem, over `KINDGI_LOG_LEVEL`: a comma list of `subsystem=level`, such as `kernel=debug,http=warn`. A dotted subsystem takes its parent's level (`kernel=debug` covers `kernel.sweeper`). A malformed entry stops the server at boot (exit code 2); a subsystem nothing logs under is a warning at boot.",
    example: 'kernel=debug',
    required: false,
    // The runtime server's; the pack service doesn't read it yet.
    appliesTo: appliesToServer,
    group: 'logging',
  },
  {
    name: 'KINDGI_LOG_FORMAT',
    description:
      '`json`: one record per line (`time`, `level`, `severity`, `subsystem`, `message`, then the ids), for a log collector. `pretty`: for a person at a terminal. `auto` (default): pretty when stdout is a terminal or `KINDGI_DEV=true`, JSON otherwise. `kindgi dev` sets `pretty`.',
    example: 'json',
    required: false,
    // The runtime server's; the pack service doesn't read it yet.
    appliesTo: appliesToServer,
    group: 'logging',
    allowedValues: ['auto', 'json', 'pretty'],
  },
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
      'Which KMS wraps DEKs (postgres backend only): `gcp` (Google Cloud KMS), or `libsodium`, a key this runtime holds (see `KINDGI_SECRETS_LOCAL_KEY_PATH`). Reserved: `aws`.',
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
  {
    name: 'KINDGI_SECRETS_LOCAL_KEY_PATH',
    description:
      "Absolute path to the local key: a file of 32 random bytes (`openssl rand 32`, mode 0600), for `KINDGI_SECRETS_BACKEND_KMS=libsodium`. It wraps every secret's data key, and it's held on this host, next to the database: back it up apart from the database, since a lost key loses every secret. Replicas mount the same file. Starting with a different key than the secrets were stored under is refused. This or `KINDGI_SECRETS_LOCAL_KEY`, not both.",
    example: '/etc/kindgi/secrets-local.key',
    required: false,
    appliesTo: appliesToPostgresLocalKey,
    group: 'local-key',
  },
  {
    name: 'KINDGI_SECRETS_LOCAL_KEY',
    description:
      'The local key itself, base64 (32 bytes; `openssl rand -base64 32`): for platforms that give secrets as environment variables. This or `KINDGI_SECRETS_LOCAL_KEY_PATH`, not both.',
    example: '',
    required: false,
    appliesTo: appliesToPostgresLocalKey,
    group: 'local-key',
  },
  {
    name: 'KINDGI_SECRETS_LOCAL_KEY_ACK',
    description:
      "Exactly `single-node`: the operator's acknowledgement that the secrets' key is held on this host, next to the database, not in a cloud KMS. Not FIPS 140-3; for regulated workloads, use a cloud KMS. Required with `KINDGI_SECRETS_BACKEND_KMS=libsodium`.",
    example: 'single-node',
    required: true,
    appliesTo: appliesToPostgresLocalKey,
    group: 'local-key',
    allowedValues: ['single-node'],
  },
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
  {
    name: 'KINDGI_PACK_SERVICE_TOKEN',
    description:
      'Shared secret between the server and the pack service. The pack service refuses any call without it, and the server sends it with every call. Required by the pack service, and by the server when `KINDGI_PACK_SERVICE_URL` is set. Use a long random value (`openssl rand -base64 32`). Both sides drop surrounding whitespace (such as the trailing newline of a stored secret), and refuse whitespace or control characters inside: the token travels in an HTTP header. The pack service removes it from its environment before it loads the pack code.',
    example: '',
    required: true,
    appliesTo: (t) => appliesToPackService(t) || appliesToServerHttpPackTransport(t),
    group: 'pack-service',
  },
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
