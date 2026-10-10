---
title: Keep secrets in your own secret manager
description: Have Kindgi keep the secrets set through its API in Azure Key Vault, Google Secret Manager or HashiCorp Vault, with only their names and version numbers in its database.
sidebar:
  order: 3.8
---

By default a deployment keeps the secrets set through Kindgi's API (`kindgi
secrets set`, `POST /v1/secrets`) in its own Postgres, encrypted with a key
your cloud's KMS wraps (`KINDGI_SECRETS_BACKEND=postgres`; see
[Self-host with Docker](../self-host/)). If your organization keeps secrets in
a secret manager already, Kindgi can keep them there instead:

```sh
KINDGI_SECRETS_BACKEND=secret-manager
KINDGI_SECRETS_MANAGER=azure    # or gcp, or vault
```

- **What lives where:** your secret manager holds every secret's values.
  Kindgi's database keeps only each secret's name and its version numbers,
  with no column for a value.
- **Versions are Kindgi's:** a secret's versions are numbered 1, 2, 3 as
  Kindgi numbers them, whatever ids the secret manager gives its own
  versions, so `kindgi secrets` reads the same on every backend.
- **Kindgi signs in as the server itself:** its managed identity, service
  account or Vault token. Give that identity access to a store, a project or
  a mount used for Kindgi's secrets alone.
- **`kindgi env init --secrets-backend=secret-manager --secrets-manager=<name>`**
  writes the settings for one.

Tools, providers and endpoints still name a secret the same way, by its name
in an env ([Store a secret](../../guides/secrets/store-a-secret/)). Only where
its values live changes.

## Azure Key Vault

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
- **Revoking** a secret disables its versions in Key Vault.

At startup, the runtime checks it can reach the vault, and says so:

```text
Secrets manager probe OK (azure-key-vault-secrets): azure-key-vault 7.5 (….vault.azure.net) (1878ms)
Secrets: your own secret manager, Azure Key Vault … (Kindgi keeps names and version numbers)
```

## Google Secret Manager

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
- **Revoking** a secret disables every one of its versions.

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
- **The policy** the token needs, on the mount (here `kindgi`):

  ```hcl
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

At startup, the runtime checks the token's access and says where it keeps
secrets:

```text
Secrets manager probe OK (vault-kv-v2): 1.15.6 (15ms)
Secrets: your own secret manager, Vault 127.0.0.1:…, mount kindgi/, token file … (Kindgi keeps names and version numbers)
```

It doesn't start (exit code 2) with a plain-`http` address outside the
rules above, or a token without the policy:

```text
KINDGI_SECRETS_VAULT_ADDR must be https:// …
Secrets manager probe failed at boot: unauthorized: … preflight capability check returned 403 … The token needs access to paths under kindgi/, a kv-v2 mount. Check …
```

The settings are all in the
[environment variable reference](../../reference/env-vars/#kindgi_secrets_manager).
AWS Secrets Manager (`KINDGI_SECRETS_MANAGER=aws`) comes in 0.1.7: a 0.1.6
runtime refuses it at startup.
