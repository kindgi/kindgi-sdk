// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.
/**
 * The hand-written parts of the environment variables reference
 * (`../env-vars.mjs`). The rest comes from `@kindgi/env-schema`.
 *
 * `scripts/check-reference.mjs` fails the docs build when a variable the
 * schema has isn't covered here, or an entry names one it no longer has.
 */

/** Each optional variable's default, as the reference shows it. */
export const ENV_DEFAULTS = {
  KINDGI_API_PORT: "the platform's `PORT` when set, else `4000`",
  KINDGI_API_HOST: 'none: binds all interfaces',
  KINDGI_PUBLIC_URL:
    'none: the address the server binds (shown as `http://localhost:<port>` when it binds all interfaces)',
  KINDGI_DATABASE_URL: '`postgres://localhost:5432/kindgi`',
  KINDGI_DATABASE_SERVER_CA_PATH:
    "none (with `KINDGI_DATABASE_SERVER_CA` unset): `KINDGI_DATABASE_URL`'s `sslmode` decides",
  KINDGI_DATABASE_SERVER_CA: 'none: same as `KINDGI_DATABASE_SERVER_CA_PATH`',
  KINDGI_DB_STATEMENT_TIMEOUT_MS:
    '`60000` (60 seconds); `0` turns it off; longer than the lock timeout when both are on',
  KINDGI_DB_LOCK_TIMEOUT_MS:
    '`30000` (30 seconds); `0` turns it off; shorter than the statement timeout when both are on',
  KINDGI_DB_IDLE_IN_TRANSACTION_TIMEOUT_MS: '`30000` (30 seconds); `0` turns it off',
  KINDGI_DB_POOL_WAIT_TIMEOUT_MS: '`10000` (10 seconds); `0` turns it off',
  KINDGI_OPENFGA_API_URL: 'none: authorization is not enforced',
  KINDGI_OPENFGA_PRESHARED_KEY: 'none: calls to OpenFGA carry no key',
  KINDGI_OPENFGA_AUTH: '`none`',
  KINDGI_TENANT_ID:
    'none: a new tenant with a generated UUID is created at each start and printed in the startup banner',
  KINDGI_TENANCY: "`single`: the runtime serves one tenant, `KINDGI_TENANT_ID`'s",
  KINDGI_API_TOKEN:
    'none: a new `kgi_bt_` token is generated at each start and printed in the startup banner',
  KINDGI_SEED_USER_ID: 'none: the user the token had at an earlier start, else a new user',
  KINDGI_DOCS: '`true`',
  KINDGI_DEV: '`false`',
  KINDGI_TENANT_HOST_ACCESS: '`local` when `KINDGI_DEV` is on, else `deployed`',
  KINDGI_WEBHOOK_PRIVATE_NETWORKS: '`deny`',
  KINDGI_PRODUCTION_GATE: '`off`: no gate, and any tenant admin can put a project in production',
  KINDGI_PRODUCTION_NEXT_URL:
    'none: `production-not-allowed` says to ask whoever runs the server, and `production-limit-reached` to take a project out of production or ask whoever runs the server to raise the limit',
  KINDGI_USAGE_METERING: '`off`: model calls are counted, nothing else',
  KINDGI_LICENSE_KEY:
    'none: outside development mode the server refuses to start; development mode needs none',
  KINDGI_LICENSE_KEY_REF: 'none: expiry warnings print a placeholder in the renew command',
  KINDGI_LICENSE_RENEWER_REF: 'none: expiry warnings print a placeholder in the renew command',
  KINDGI_ENV:
    'none: `local` in development mode, else no env (a tool that declares secrets or env values fails its calls)',
  KINDGI_REFUSE_OTHER_ENVS: '`false`: a value or a registration under any env is taken',
  KINDGI_PUBLIC_TOKEN_SIGNING_KEY_PATH:
    'none: in development mode a key generated at start; otherwise public run tokens are off',
  KINDGI_PUBLIC_TOKEN_SIGNING_KEY:
    'none: same as `KINDGI_PUBLIC_TOKEN_SIGNING_KEY_PATH` (development key, or public run tokens off)',
  KINDGI_AUTH_SECRET_PATH:
    'none (with `KINDGI_AUTH_SECRET` unset): sign-in with identity providers is off',
  KINDGI_AUTH_SECRET:
    'none (with `KINDGI_AUTH_SECRET_PATH` unset): sign-in with identity providers is off',
  KINDGI_AUTH_PREVIOUS_SECRET_PATH: 'none: no previous secret',
  KINDGI_AUTH_PREVIOUS_SECRET: 'none: no previous secret',
  KINDGI_AUTH_PRIVATE_IDP_ORIGINS: 'none: none; only public HTTPS identity providers are allowed',
  KINDGI_AUTH_VERIFIED_DOMAINS:
    "none: none; a runtime serving one tenant routes that tenant's domains without it, one serving several routes no domain",
  KINDGI_AUTH_TENANT_PROVIDERS: '`on`',
  KINDGI_AUTH_GOOGLE_CLIENT_ID: 'none: "Continue with Google" is off',
  KINDGI_AUTH_GOOGLE_CLIENT_SECRET:
    'none: no secret (the client id then needs `KINDGI_AUTH_GOOGLE_CLIENT_SECRET_PATH`)',
  KINDGI_AUTH_GOOGLE_CLIENT_SECRET_PATH: 'none: no secret file',
  KINDGI_AUTH_MICROSOFT_CLIENT_ID: 'none: "Continue with Microsoft" is off',
  KINDGI_AUTH_MICROSOFT_CLIENT_SECRET:
    'none: no secret (the client id then needs `KINDGI_AUTH_MICROSOFT_CLIENT_SECRET_PATH`)',
  KINDGI_AUTH_MICROSOFT_CLIENT_SECRET_PATH: 'none: no secret file',
  KINDGI_AUTH_GITHUB_CLIENT_ID: 'none: "Continue with GitHub" is off',
  KINDGI_AUTH_GITHUB_CLIENT_SECRET:
    'none: no secret (the client id then needs `KINDGI_AUTH_GITHUB_CLIENT_SECRET_PATH`)',
  KINDGI_AUTH_GITHUB_CLIENT_SECRET_PATH: 'none: no secret file',
  KINDGI_AUTH_EMAIL_SMTP_URL:
    'none (with `KINDGI_AUTH_EMAIL_SMTP_URL_PATH` unset): the emailed sign-in link is off',
  KINDGI_AUTH_EMAIL_SMTP_URL_PATH: 'none: no SMTP URL file',
  KINDGI_REVIEWER_EMAIL: '`off`',
  KINDGI_SITE_SIGN_IN: '`false`: no site signs anyone in',
  KINDGI_AUTH_EMAIL_FROM: 'none: the emailed sign-in link is off (required with the SMTP URL)',
  KINDGI_AUTH_EMAIL_LINK_DAILY_CAP: '`20` links a day (a whole number from 1 to 1000)',
  KINDGI_AUTH_INVITE_EMAIL_DAILY_CAP:
    '`500` invitation emails in 24 hours, all tenants together (a whole number from 1 to 100000)',
  KINDGI_AUTH_TURNSTILE_SECRET:
    'none (with `KINDGI_AUTH_TURNSTILE_SECRET_PATH` unset): no Turnstile check on emailed-link requests',
  KINDGI_AUTH_TURNSTILE_SECRET_PATH: 'none: no Turnstile secret file',
  KINDGI_AUTH_TURNSTILE_SITE_KEY: 'none: no Turnstile widget',
  KINDGI_AUTH_TERMS_URL: 'none: the sign-in page links no terms',
  KINDGI_AUTH_PRIVACY_URL: 'none: the sign-in page links no privacy policy',
  KINDGI_CONSOLE_LINKS: "none: the console shows no links of the deployment's own",
  KINDGI_TRUSTED_PROXIES:
    "none: no trusted proxies; the connection's peer is the client address and `X-Forwarded-For` is ignored",
  KINDGI_SESSION_TTL_MS: '`43200000` (12 hours); at least `60000`',
  KINDGI_SESSION_IDLE_TIMEOUT_MS:
    '`3600000` (60 minutes); at least `60000`, at most the session lifetime',
  KINDGI_CONSOLE_TOKEN_SIGN_IN: '`off`, and `on` when `KINDGI_DEV` is on',
  KINDGI_EXPORT_SIGNING_KEY_PATH:
    'none (with the other two export key variables unset): in development mode a key generated at start; otherwise exports answer `404 signing-not-configured`',
  KINDGI_EXPORT_SIGNING_KEY: 'none: same as `KINDGI_EXPORT_SIGNING_KEY_PATH`',
  KINDGI_EXPORT_SIGNING_KMS_KEY:
    'none: the export key comes from `KINDGI_EXPORT_SIGNING_KEY_PATH` or `KINDGI_EXPORT_SIGNING_KEY`',
  KINDGI_EXPORT_SIGNING_RETIRED_PUBLIC_KEYS_PATH: 'none: no retired export keys are listed',
  KINDGI_EXPORT_SIGNING_RETIRED_PUBLIC_KEYS: 'none: no retired export keys are listed',
  KINDGI_CORS_ORIGINS: 'none: no CORS headers on any route',
  KINDGI_EGRESS_SERVER_ADDRESSES:
    'none: no server addresses are published (with `KINDGI_EGRESS_DEPLOYMENT_ADDRESSES` unset too, `GET /v1/tenant` has no `egress`)',
  KINDGI_EGRESS_DEPLOYMENT_ADDRESSES:
    'none: no deployment addresses are published (with `KINDGI_EGRESS_SERVER_ADDRESSES` unset too, `GET /v1/tenant` has no `egress`)',
  KINDGI_RUN_LEASE_MS: '`300000` (5 minutes); at least `10000`',
  KINDGI_RUN_SWEEP_INTERVAL_MS: '`60000` (1 minute); at least `1000`, shorter than the lease',
  KINDGI_RUN_ENDED_CHECK_MS: '`5000` (5 seconds); at least `1000`',
  KINDGI_MEMORY_EMBEDDINGS: 'none: memory search by keyword only',
  KINDGI_MEMORY_EMBEDDINGS_URL:
    'none: required when `KINDGI_MEMORY_EMBEDDINGS=openai-compat`, not read otherwise',
  KINDGI_MEMORY_EMBEDDINGS_MODEL:
    'none: required when `KINDGI_MEMORY_EMBEDDINGS=openai-compat`, not read otherwise',
  KINDGI_MEMORY_EMBEDDINGS_API_KEY: 'none: requests carry no key',
  KINDGI_RETENTION_SWEEP_INTERVAL_MS: 'none: no automatic purge; at least `60000` when set',
  KINDGI_RUN_RETENTION_MAX_DAYS: 'none: runs are kept as their retention policy says',
  KINDGI_ERASURE_SHARED_WAIT_MS: '`604800000` (7 days); at least `3600000`',
  KINDGI_ERASURE_LEDGER_KEY_PATH:
    'none (with `KINDGI_ERASURE_LEDGER_KEY` unset): erasures run but cannot be replayed after a restore',
  KINDGI_ERASURE_LEDGER_KEY: 'none: same as `KINDGI_ERASURE_LEDGER_KEY_PATH`',
  KINDGI_ERASURE_LEDGER_EXPORT: 'none: the ledger stays in the database only',
  KINDGI_ERASURE_LEDGER_EXPORT_INTERVAL_MS: '`3600000` (an hour); at least `60000`',
  KINDGI_TENANT_PURGE_RECORD:
    'none: `POST /v1/system/tenants/{tenantId}/purge` refuses every purge (`purge-record-unset`)',
  KINDGI_PASSIVE: '`off`',
  KINDGI_PAGINATION_KEY_PATH:
    'none (with `KINDGI_PAGINATION_KEY` unset): a random key made at start and kept nowhere',
  KINDGI_PAGINATION_KEY: 'none: same as `KINDGI_PAGINATION_KEY_PATH`',
  KINDGI_PAGINATION_PREVIOUS_KEY_PATH: 'none: no previous key',
  KINDGI_PAGINATION_PREVIOUS_KEY: 'none: no previous key',
  KINDGI_COMPLIANCE_CLASSIFIER: 'none: no compliance routes, and no audit event is purged',
  KINDGI_ARTIFACTS: 'none: artifacts are off (no `/v1/artifacts`)',
  KINDGI_TURN_MEMORY_MIB: "none: no limit on every tenant's turns together",
  KINDGI_TURN_MEMORY_PER_TENANT_MIB: 'none: no limit per tenant',
  KINDGI_FILE_MEMORY_MIB:
    "`512`, or a quarter of the server's memory when that's less; at least `35`",
  KINDGI_FILE_CACHE_MIB: 'half of `KINDGI_FILE_MEMORY_MIB`; `0` keeps none',
  KINDGI_TEMPLATE_RENDER_WORKERS:
    '`1` when `KINDGI_TENANCY=multi`, else `0`: the template renders in the server process',
  KINDGI_TEMPLATE_RENDER_WORKER_HEAP_MIB: '`128`; at least `1`',
  KINDGI_ARTIFACT_MAX_BYTES: '`104857600` (100 MiB)',
  KINDGI_LOG_LEVEL: '`info`',
  KINDGI_LOG_LEVELS: 'none: no per-subsystem levels; `KINDGI_LOG_LEVEL` applies everywhere',
  KINDGI_LOG_FORMAT:
    '`auto`: `pretty` when stdout is a terminal or `KINDGI_DEV` is on, else `json`',
  KINDGI_SECRETS_BACKEND:
    "`none` (the secrets routes are not served, and a workspace's own identity providers can't be added or changed)",
  KINDGI_SECRETS_DOTENV_FILES: '`.env,.env.local`',
  KINDGI_SECRETS_AAD_KEY_PATH:
    'none (with `KINDGI_SECRETS_AAD_KEY` unset): no key; the postgres backend refuses to start without one of the two',
  KINDGI_SECRETS_AAD_KEY: 'none: same as `KINDGI_SECRETS_AAD_KEY_PATH`',
  KINDGI_AWS_IDENTITY:
    'none: the server has no AWS identity; a registration that needs one is refused',
  KINDGI_AWS_PROFILE: '`default`',
  KINDGI_AWS_ROLE_ARN: "none: no role is assumed on top of the server's AWS identity",
  KINDGI_AWS_ROLE_SESSION_NAME: '`kindgi-runtime`',
  KINDGI_AWS_STS_REGION:
    'the value of `AWS_REGION`; the server refuses to start when a role or web identity is used and neither is set',
  KINDGI_AZURE_CLIENT_ID: "none: the service's system-assigned managed identity",
  KINDGI_SECRETS_VAULT_MOUNT: '`secret`',
  KINDGI_SECRETS_VAULT_NAMESPACE: 'none: no namespace',
  KINDGI_SECRETS_VAULT_TOKEN_FILE:
    'none: the server signs in with `KINDGI_SECRETS_VAULT_K8S_ROLE` instead; one of the two is required',
  KINDGI_SECRETS_VAULT_K8S_ROLE:
    'none: the server signs in with `KINDGI_SECRETS_VAULT_TOKEN_FILE` instead; one of the two is required',
  KINDGI_SECRETS_VAULT_K8S_MOUNT: '`kubernetes`',
  KINDGI_SECRETS_VAULT_K8S_TOKEN_FILE: '`/var/run/secrets/kubernetes.io/serviceaccount/token`',
  KINDGI_SECRETS_AWS_KMS_KEY_ID: "none: AWS's own `aws/secretsmanager` key",
  KINDGI_SECRETS_LOCAL_KEY_PATH:
    'none (with `KINDGI_SECRETS_LOCAL_KEY` unset): no key; the libsodium KMS refuses to start without one of the two',
  KINDGI_SECRETS_LOCAL_KEY: 'none: same as `KINDGI_SECRETS_LOCAL_KEY_PATH`',
  KINDGI_PACK_SERVICE_URL: 'none: no pack service; a pack tool fails saying none is wired',
  KINDGI_PACK_CALL_TIMEOUT_MS: '`120000` (2 minutes)',
  KINDGI_PACK_SERVICE_AUTH: '`token`',
  KINDGI_PACK_INDEX: '`/app/index.json` (the `--index` flag wins)',
  KINDGI_PACK_SERVICE_MAX_CONCURRENCY: '`32`',
  KINDGI_PACK_ENV_CHECK: '`strict`',
  KINDGI_PACK_ENV_FILTER: '`on`',
  KINDGI_PACK_ENV_DECLARED:
    'none: the launcher drops nothing (an image built by `kindgi build` sets it)',
  KINDGI_PACK_TENANT_ID: "none: no check, the pack service answers any tenant's calls",
  KINDGI_PACK_ROUTING: '`single`: one pack service, `KINDGI_PACK_SERVICE_URL`, for every call',
  KINDGI_PACK_ENDPOINT_HOSTS:
    'none: with `KINDGI_PACK_ROUTING=per-deployment`, the server refuses to start',
  KINDGI_IMAGE_REGISTRY_HOST: 'none: every registry is read anonymously',
  KINDGI_IMAGE_REGISTRY_USERNAME: 'none: no credentials (anonymous reads)',
  KINDGI_IMAGE_REGISTRY_PASSWORD: 'none: no credentials (anonymous reads)',
  KINDGI_IMAGE_REGISTRY_INSECURE_HOSTS: 'none: loopback hosts always use plain HTTP',
  KINDGI_IMAGE_REGISTRY_AUTH: '`static`',
  KINDGI_PACK_DIR: 'none: packs come from signed deployments in Postgres',
  KINDGI_DEV_CONSOLE_LOGIN: '`false`',
  KINDGI_DEV_HOST_ALIAS: 'none: calls to loopback addresses connect as written',
};

/**
 * An example for each variable whose schema entry has none (all of them
 * secrets or keys): the value's shape, and a command that makes one when
 * there is one (the example then makes it in place). A shape without a
 * command is a placeholder, so it's plain words: no commas, `#` or
 * parentheses, which a pasted shell line can't hold.
 */
export const ENV_EXAMPLES = {
  KINDGI_OPENFGA_PRESHARED_KEY: {
    value: '<long random value without spaces or commas>',
    make: 'openssl rand -hex 32',
  },
  KINDGI_LICENSE_KEY: {
    value: 'kgi_lk_<payload>.<signature>',
  },
  KINDGI_PUBLIC_TOKEN_SIGNING_KEY: {
    value: '<base64 of an Ed25519 private key in PKCS#8 PEM>',
    make: "openssl genpkey -algorithm ed25519 | base64 | tr -d '\\n'",
  },
  KINDGI_AUTH_SECRET: {
    value: '<32 random bytes, base64>',
    make: 'openssl rand -base64 32',
  },
  // The secret it held before the rotation, not a new one.
  KINDGI_AUTH_PREVIOUS_SECRET: {
    value: '<the KINDGI_AUTH_SECRET value before the rotation>',
  },
  KINDGI_AUTH_GOOGLE_CLIENT_ID: {
    value: '<client id of your Google OAuth app>',
  },
  KINDGI_AUTH_GOOGLE_CLIENT_SECRET: {
    value: '<client secret of your Google OAuth app>',
  },
  KINDGI_AUTH_MICROSOFT_CLIENT_ID: {
    value: '<application id of your Microsoft app>',
  },
  KINDGI_AUTH_MICROSOFT_CLIENT_SECRET: {
    value: '<client secret of your Microsoft app>',
  },
  KINDGI_AUTH_GITHUB_CLIENT_ID: {
    value: '<client id of your GitHub OAuth app>',
  },
  KINDGI_AUTH_GITHUB_CLIENT_SECRET: {
    value: '<client secret of your GitHub OAuth app>',
  },
  KINDGI_AUTH_EMAIL_SMTP_URL: {
    value: 'smtps://<user>:<password>@smtp.example.com:465',
  },
  KINDGI_AUTH_TURNSTILE_SECRET: {
    value: '<Cloudflare Turnstile secret key>',
  },
  KINDGI_AUTH_TURNSTILE_SITE_KEY: {
    value: '<Cloudflare Turnstile site key>',
  },
  KINDGI_EXPORT_SIGNING_KEY: {
    value: '<base64 of an Ed25519 or EC P-256 private key in PKCS#8 PEM>',
    make: "openssl genpkey -algorithm ed25519 | base64 | tr -d '\\n'",
  },
  KINDGI_EXPORT_SIGNING_RETIRED_PUBLIC_KEYS: {
    value: '<base64 of a file of PEM public keys>',
    make: "openssl pkey -in old-key.pem -pubout | base64 | tr -d '\\n'",
  },
  KINDGI_MEMORY_EMBEDDINGS_API_KEY: {
    value: '<API key of the embeddings endpoint>',
  },
  KINDGI_DATABASE_SERVER_CA: {
    value: '<the database server CA certificates in PEM>',
    make: 'cat database-ca.pem',
  },
  KINDGI_ERASURE_LEDGER_KEY: {
    value: '<32 random bytes, base64>',
    make: 'openssl rand -base64 32',
  },
  KINDGI_PAGINATION_KEY: {
    value: '<32 random bytes, base64>',
    make: 'openssl rand -base64 32',
  },
  // The key it held before the rotation, not a new one.
  KINDGI_PAGINATION_PREVIOUS_KEY: {
    value: '<the KINDGI_PAGINATION_KEY value before the rotation>',
  },
  KINDGI_SECRETS_AAD_KEY: {
    value: '<32 random bytes, base64>',
    make: 'openssl rand -base64 32',
  },
  KINDGI_SECRETS_LOCAL_KEY: {
    value: '<32 random bytes, base64>',
    make: 'openssl rand -base64 32',
  },
  KINDGI_PACK_SERVICE_TOKEN: {
    value: '<long random value, printable ASCII without spaces>',
    make: 'openssl rand -hex 32',
  },
  KINDGI_PACK_TENANT_ID: {
    value: '<UUID of the tenant this pack service serves>',
  },
  KINDGI_IMAGE_REGISTRY_PASSWORD: {
    value: '<registry password or read-only access token>',
  },
};

/** "See also" for each group's variables that no guide names: page slugs. */
export const ENV_GROUP_SEE_ALSO = {
  core: ['deploy/self-hosted/self-host', 'deploy/self-hosted/operate'],
  logging: ['deploy/self-hosted/logs'],
  secrets: ['deploy/self-hosted/secret-manager', 'guides/secrets/index'],
  gcp: ['deploy/self-hosted/cloud-run', 'deploy/self-hosted/secret-manager'],
  aws: ['deploy/self-hosted/secret-manager'],
  azure: ['deploy/self-hosted/azure-container-apps', 'deploy/self-hosted/secret-manager'],
  vault: ['deploy/self-hosted/secret-manager'],
  'local-key': ['deploy/self-hosted/self-host'],
  'pack-service': ['deploy/self-hosted/self-host', 'concepts/architecture'],
  'image-registry': ['deploy/self-hosted/self-host', 'concepts/security'],
  dev: ['guides/secrets/dev-sandbox', 'deploy/self-hosted/self-host'],
};
