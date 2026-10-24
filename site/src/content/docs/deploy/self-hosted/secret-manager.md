---
title: Keep secrets in your own secret manager
description: Have Kindgi keep the secrets set through its API in AWS Secrets Manager, Azure Key Vault, Google Secret Manager or HashiCorp Vault, with only their names and version numbers in its database.
sidebar:
  order: 3.8
---

When you finish this page, the secrets set through Kindgi's API live in your
own secret manager: AWS Secrets Manager, Azure Key Vault, Google Secret
Manager, or HashiCorp Vault or OpenBao. Kindgi's database keeps only their
names and version numbers.

By default, a deployment keeps the secrets set through Kindgi's API in its
own Postgres: those from `kindgi secrets set` or `POST /v1/secrets`. A key
your cloud's KMS wraps encrypts them (`KINDGI_SECRETS_BACKEND=postgres`;
[Self-host with Docker](../self-host/)). If your organization keeps secrets
in a secret manager already, Kindgi can keep them there instead.

## Before you start

- **A runtime you deploy yourself,** whose settings you can change
  ([Self-host with Docker](../self-host/)).
- **For AWS Secrets Manager, runtime 0.1.7 or later.** A 0.1.6 runtime
  refuses it at startup.
- **A store for Kindgi's secrets alone:** a Key Vault, a Google Cloud
  project, a Vault mount, or a `kindgi/` prefix in AWS Secrets Manager.
- **The server's own identity on your cloud,** with access to that store.
  Kindgi signs in as the server itself: its AWS identity, managed identity,
  service account, Vault token or Kubernetes service account.
- **For `kindgi` commands:** Kindgi 0.2's CLI, which runs from any folder as
  `npx --yes @kindgi/cli@0.2` ([Install](../../../start/install/)). Inside a
  pack project, `pnpm exec kindgi` runs the project's pinned CLI instead. The
  `env init` step needs the pack's folder, so it uses `pnpm exec kindgi`.

## How it works

- **What lives where:** your secret manager holds every secret's values.
  Kindgi's database keeps only each secret's name and its version numbers,
  with no column for a value.
- **Versions are Kindgi's:** a secret's versions are numbered 1, 2, 3 as
  Kindgi numbers them, whatever ids the secret manager gives its own
  versions. So `kindgi secrets` reads the same on every backend.
- **Tools, providers and endpoints still name a secret the same way,** by
  its name in an env ([Store a secret](../../../guides/secrets/store-a-secret/)).
  Only where its values live changes.
- **A name outside the rule for new names**
  ([Store a secret](../../../guides/secrets/store-a-secret/)) isn't sent to
  your secret manager. A secret stored under one can't be read or rotated:
  it's refused with `secret-store-error`, and `kindgi secrets set` refuses
  the name with `secret-name-invalid`. Store its value again under a name
  that fits, point what uses it at the new name, then revoke the old one.
  Revoking it leaves its value in your secret manager, so delete it there
  too. `--hard` can't erase it either: the old name is revoked as without
  it, so `kindgi secrets list --include-revoked` still shows it, and the
  answer is `secret-store-error` to say the value is left there.

## Choose the backend

Set these in the runtime's settings, such as `kindgi.env`, then follow your
secret manager's section:

```sh
KINDGI_SECRETS_BACKEND=secret-manager
KINDGI_SECRETS_MANAGER=aws    # or azure, gcp, or vault
```

`kindgi env init` writes a settings file to start from:

```sh
pnpm exec kindgi env init --secrets-backend=secret-manager --secrets-manager=aws
```

- `--secrets-backend=secret-manager` keeps the secrets in a secret manager.
- `--secrets-manager` names which one: `aws`, `azure`, `gcp` or `vault`.
- It writes `.env.example` in the current directory. `--out=<path>` writes
  it elsewhere, and `--force` overwrites a file that's there.

It prints where it wrote the file, and for which backend:

```text
{
  "outPath": "…/.env.example",
  "target": {
    "secretsBackend": "secret-manager",
    "secretsManager": "aws"
  },
  "varsWritten": 90
}

  Wrote 90 env-var entries → …/.env.example
  Target: {"secretsBackend":"secret-manager","secretsManager":"aws"}
```

Each section shows the lines the runtime's startup log prints when it reaches
your secret manager, and what it prints when it can't.

## AWS Secrets Manager

Set the region and the server's AWS identity:

```sh
KINDGI_SECRETS_MANAGER=aws
KINDGI_SECRETS_AWS_REGION=ca-central-1
KINDGI_AWS_IDENTITY=container    # or instance, or web-identity
```

- **The region:** the one whose Secrets Manager holds Kindgi's secrets, in
  AWS's commercial, GovCloud or China partition. The runtime refuses a
  region in any other partition at startup.
- **The identity:** the server signs in as its own AWS identity
  ([`KINDGI_AWS_IDENTITY`](../../../reference/env-vars/#kindgi_aws_identity)):
  - `container` for ECS, Fargate or EKS Pod Identity;
  - `instance` for an EC2 instance profile;
  - `web-identity` for EKS IRSA;
  - `profile`, only in development.

  `KINDGI_AWS_ROLE_ARN` has it assume a role on top. It never uses `AWS_*`
  keys or the AWS SDK's default chain. Without `KINDGI_AWS_IDENTITY`, the
  runtime doesn't start.
- **The permissions:** the actions Kindgi calls, all on
  `arn:aws:secretsmanager:<region>:<account>:secret:kindgi/*` only
  (`arn:aws-us-gov:` in GovCloud, `arn:aws-cn:` in China):
  `secretsmanager:CreateSecret`, `secretsmanager:TagResource`,
  `secretsmanager:PutSecretValue`, `secretsmanager:GetSecretValue`,
  `secretsmanager:DescribeSecret` and `secretsmanager:DeleteSecret`.
  Kindgi doesn't need `ListSecrets`, which can't be limited to a prefix, or
  `RestoreSecret`.
- **The key:** AWS encrypts the secrets with its own `aws/secretsmanager`
  key, or with yours. `KINDGI_SECRETS_AWS_KMS_KEY_ID` names yours: a key
  ARN, a key id or an `alias/…`. The identity then also needs
  `kms:GenerateDataKey` and `kms:Decrypt` on it.
- **What Kindgi writes:** one AWS secret per Kindgi secret, named
  `kindgi/<hash>`, with its scope in tags (`kindgi_tenant_id`,
  `kindgi_env_name`, …) and its Kindgi path in the description. Each
  version is an AWS version whose id carries Kindgi's number, and a
  retried write adds none.
- **Revoking** a secret deletes it in AWS with a 30-day recovery window.
  AWS can't disable a single version, so the whole secret goes. Kindgi
  refuses a revoked secret at once, from its own records. Read directly from
  AWS, it may still answer for a moment, since "All Secrets Manager
  operations are eventually consistent"
  ([AWS](https://docs.aws.amazon.com/secretsmanager/latest/apireference/API_ListSecrets.html)).
  Within the window, an AWS admin can restore it, until the name is set
  again in Kindgi. With `--hard`, see [Revoking for good](#revoking-for-good).

At startup, the runtime checks it can reach Secrets Manager as its identity,
and says where it keeps secrets (`2017-10-17` is Secrets Manager's API
version):

```text
Secrets manager probe OK (aws-secrets-manager): 2017-10-17 (271ms)
  Secrets: your own secret manager, AWS Secrets Manager in us-east-2, as the server's AWS identity (Kindgi keeps names and version numbers)
```

It doesn't start (exit code 2) without `KINDGI_AWS_IDENTITY`, or with a
region outside those partitions:

```text
KINDGI_SECRETS_MANAGER=aws signs in as the server's AWS identity: set KINDGI_AWS_IDENTITY (container, instance or web-identity; profile in development). Kindgi never uses the AWS SDK's default chain or AWS_* keys.
KINDGI_SECRETS_AWS_REGION must be an AWS region in the commercial, GovCloud or China partition, such as ca-central-1. Got "us-iso-east-1".
```

**Setting a revoked secret again** deletes the revoked one for good, so its
values can't be restored, then makes a fresh one under the same name. That
waits for AWS to finish deleting, up to a minute (26 to 28 seconds in our
test). Kindgi's version numbers carry on, and the runtime logs a warning
that names the secret, never its value:

```text
13:47:45.067 WARN  [secrets] Secret "stripe-key" was set again after a revoke: aws-secrets-manager deleted its revoked values for good, ending their recovery window early. tenantId=… scopeKind=tenant envName=staging name=stripe-key versionId=3 provider=aws-secrets-manager
```

If it's revoked again while it's being set, the set fails rather than
reporting a conflict, with `secret-provider-unavailable`:
`kindgi/… was revoked again while it was being set: set it again.`

**AWS's limits:** AWS sets how many versions of a secret it keeps, and how
often to write one; see its
[Secrets Manager quotas](https://docs.aws.amazon.com/secretsmanager/latest/userguide/reference_limits.html).
Kindgi writes exactly one AWS version per set or rotation. Reading a version
AWS no longer keeps, one pinned by number for example, answers
`secret-not-found` with the reason `deleted-at-provider`: `Secret "<name>"
version <N> is mapped, but its provider has no value for it (deleted at the
provider).`

## Azure Key Vault

Set the vault:

```sh
KINDGI_SECRETS_MANAGER=azure
KINDGI_SECRETS_AZURE_VAULT_URL=https://<vault>.vault.azure.net
```

- **The vault:** one for these secrets alone, not the one your deployment's
  own secrets are in.
- **The identity:** the server's managed identity needs the **Key Vault
  Secrets Officer** role on the vault, to create, version, disable and
  recover secrets. `KINDGI_AZURE_CLIENT_ID` names a user-assigned identity;
  without it, the server uses its system-assigned one.
- **What Kindgi writes:** one Key Vault secret per Kindgi secret, under a
  hashed name (`kindgi-…`), each version tagged with Kindgi's number
  (`kindgi-version`).
- **Revoking** a secret disables its versions in Key Vault. With `--hard`,
  see [Revoking for good](#revoking-for-good).

At startup, the runtime checks it can reach the vault, and says so:

```text
Secrets manager probe OK (azure-key-vault-secrets): azure-key-vault 7.5 (….vault.azure.net) (1878ms)
Secrets: your own secret manager, Azure Key Vault … (Kindgi keeps names and version numbers)
```

## Google Secret Manager

Set the project:

```sh
KINDGI_SECRETS_MANAGER=gcp
KINDGI_SECRETS_GCP_PROJECT_ID=<project id>
```

- **The project:** one used for Kindgi's secrets alone, with the Secret
  Manager API on.
- **The identity:** the server's service account needs to create and
  delete secrets there, and add, read and disable their versions: Secret
  Manager Admin (`roles/secretmanager.admin`), the predefined role that can
  create secrets.
- **What Kindgi writes:** one Secret Manager secret per Kindgi secret, under
  a hashed id, labelled with its tenant (`kindgi_tenant_id`) and annotated
  with its Kindgi path (`kindgi-path`). Its versions are numbered as
  Kindgi's.
- **Revoking** a secret disables every one of its versions. With `--hard`,
  see [Revoking for good](#revoking-for-good).

At startup, the runtime checks it can use Secret Manager in the project, and
says where it keeps secrets:

```text
Secrets manager probe OK (gcp-secret-manager): v1 (439ms)
  Secrets: your own secret manager, Google Secret Manager in project … (Kindgi keeps names and version numbers)
```

With the Secret Manager API off in the project, it doesn't start (exit code
2). The middle of the message is Google's own:

```text
Secrets manager probe failed at boot: unauthorized: Secret Manager isn't turned on in this project: Secret Manager API has not been used in project … before or it is disabled. … Check KINDGI_SECRETS_GCP_PROJECT_ID, that the Secret Manager API is on in that project, and that the runtime's service account has roles/secretmanager.admin on it (it creates secrets, adds, reads and disables versions, and deletes secrets).
```

## HashiCorp Vault or OpenBao

Set the address, the mount and the token:

```sh
KINDGI_SECRETS_MANAGER=vault
KINDGI_SECRETS_VAULT_ADDR=https://vault.example.com:8200
KINDGI_SECRETS_VAULT_MOUNT=kindgi
KINDGI_SECRETS_VAULT_TOKEN_FILE=/var/run/kindgi/vault-token
```

- **The address:** `https://`, or plain `http://` only to a Vault Agent on
  the same machine (`http://127.0.0.1:8100`) or in development. For a custom
  CA, set `NODE_EXTRA_CA_CERTS`.
- **The mount:** a kv version 2 mount for Kindgi's secrets alone
  (`KINDGI_SECRETS_VAULT_MOUNT`; `secret` by default). For Vault Enterprise
  or HCP Vault, `KINDGI_SECRETS_VAULT_NAMESPACE` names the namespace.
- **The token:** a file the platform keeps fresh, such as Vault Agent's
  sink or a mounted secret. Kindgi reads it again every minute, and whenever
  Vault refuses the token, so a rotated token is picked up. It never reads
  `VAULT_TOKEN` or `~/.vault-token`.
- **Or Kubernetes login,** for a runtime in a pod: it signs in to Vault's
  Kubernetes auth method with the pod's own service account, as the role
  `KINDGI_SECRETS_VAULT_K8S_ROLE` names. `KINDGI_SECRETS_VAULT_K8S_MOUNT`
  names the auth method's mount (`kubernetes` by default), and
  `KINDGI_SECRETS_VAULT_K8S_TOKEN_FILE` another token file (the pod's
  service account token by default). Set the role or the token file, not
  both: the runtime refuses both at startup, and refuses the mount or the
  token file without the role.
- **The policy** the token needs, on the mount (here `kindgi`):

  ```hcl excerpt
  path "kindgi/data/*" {
    capabilities = ["create", "read", "update"]
  }
  path "kindgi/metadata/*" {
    capabilities = ["read", "delete", "list"]
  }
  path "kindgi/delete/*" {
    capabilities = ["update"]
  }
  path "kindgi/destroy/*" {
    capabilities = ["update"]
  }
  ```

- **Revoking** a secret soft-deletes every one of its versions in Vault.
  With `--hard`, see [Revoking for good](#revoking-for-good).

At startup, the runtime checks the token's access and says where it keeps
secrets:

```text
Secrets manager probe OK (vault-kv-v2): 1.15.6 (15ms)
Secrets: your own secret manager, Vault 127.0.0.1:…, mount kindgi/, token file … (Kindgi keeps names and version numbers)
```

With Kubernetes login, in a pod:

```text
Secrets manager probe OK (vault-kv-v2): 1.15.6 (69ms)
  Secrets: your own secret manager, Vault vault.….svc:8200, mount kindgi/, Kubernetes login, role kindgi-runtime (Kindgi keeps names and version numbers)
```

It doesn't start, with exit code 2, when the address is plain `http` that
this section's address rules don't allow, or the token lacks the policy:

```text
KINDGI_SECRETS_VAULT_ADDR must be https:// …
Secrets manager probe failed at boot: unauthorized: … preflight capability check returned 403 … The token needs access to paths under kindgi/, a kv-v2 mount. Check …
```

With Kubernetes login, a pod whose service account the role doesn't bind
doesn't start either (exit code 2). The part after `403:` is Vault's own:

```text
Secrets manager probe failed at boot: unauthorized: Vault probe failed: Vault's Kubernetes login (auth/kubernetes, role kindgi-runtime) answered 403: service account name not authorized. Check that the role exists, binds this service account and namespace, and that the auth method can review tokens. Check …
```

## Revoking for good

`kindgi secrets revoke <NAME> --env=<runtime env> --scope=<kind>[:id] --hard`
(`DELETE /v1/secrets/{name}?hard=true`) erases a secret's values at Kindgi.
It needs the `secrets:revoke:hard` capability
([Who can do what](../../people-and-keys/#who-can-do-what)), and it can't be
undone:

- No read, list or version shows the secret again. A read answers as for a
  name never used there: `secret-not-found`, or the same name's value at a
  wider scope.
- Its name and the revoke stay on record for the audit trail.
- Setting the name again later stores a new value under it.

What's left after that follows where the values were:

- **Kindgi's own store** (`KINDGI_SECRETS_BACKEND=postgres`): every
  version's encrypted value and its wrapped key are cleared in the database
  at once.
  - Copies made before then stay in Postgres's write-ahead log, its replicas
    and its backups, until your backup retention ages them out.
  - The KMS key isn't destroyed, since it wraps every secret's key. So a
    backup from before the revoke, with the KMS key and the AAD key
    ([Back up and restore](../back-up-and-restore/)), still decrypts the
    value until the backup ages out.
  - Restoring a backup from before the revoke brings the secret back as it
    was, so revoke it again after the restore.
- **AWS Secrets Manager:** the secret is deleted with no recovery window, so
  it can't be restored.
- **Google Secret Manager:** the secret is deleted with all its versions,
  which Google calls irreversible.
- **HashiCorp Vault or OpenBao:** every version is destroyed, then the
  secret's metadata. Backups of Vault's own storage keep them until they age
  out.
- **Azure Key Vault:** the secret is deleted, and Key Vault keeps it
  soft-deleted for the vault's retention period: 7 to 90 days, set when the
  vault was made
  ([Microsoft](https://learn.microsoft.com/en-us/azure/key-vault/general/soft-delete-overview)).
  - Within that period, a vault admin can recover it, with its versions as
    they were.
  - Setting the name again in Kindgi within that period recovers it too,
    old versions included, before the new value is written. Kindgi never
    reads the old ones, but they're back in the vault as they were.

## Next

- [The environment variable reference](../../../reference/env-vars/#kindgi_secrets_manager):
  every setting on this page.
- [Store a secret](../../../guides/secrets/store-a-secret/): set and read
  secrets, whatever the backend.
- [Operate a self-hosted runtime](../operate/): health, backups and
  rotating keys.
