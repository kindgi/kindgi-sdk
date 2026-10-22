---
title: Rotate the runtime's tokens and keys
description: Replace a self-hosted Kindgi runtime's API token, pack service token, license key, signing key and public run token key.
sidebar:
  order: 3.4
---

This guide replaces each token and key a self-hosted runtime uses, so an old
one stops working.

## Before you start

- **A runtime running as [Self-host Kindgi](../self-host/) sets it up:** the
  `kindgi-server` and `kindgi-pack` containers, on the `kindgi` network, with
  `kindgi.env` and `pack.env`.
- **Docker** and **OpenSSL**, on the machine that runs the containers.
- **`KINDGI_API_TOKEN` exported in your shell** as the runtime's API token,
  where the `kindgi` commands read it.
- **For `kindgi` commands:** Kindgi 0.2's CLI, which runs from any folder as
  `npx --yes @kindgi/cli@0.2` ([Install](../../../start/install/)). Inside a
  pack project, `pnpm exec kindgi` runs the project's pinned CLI instead. The
  build and deploy steps need the pack's folder, so they use `pnpm exec kindgi`.

Each rotation ends with a restart, as
[Restart the runtime](../restart-and-check-health/#restart-the-runtime)
shows.

## Rotate the API token

A new API token replaces the one your CLI, apps and console sign-ins use.

Make a new token:

```sh
printf 'kgi_bt_%s\n' "$(openssl rand -hex 32)"
```

It prints a token, elided here:

```text
kgi_bt_67db…570b
```

Replace `KINDGI_API_TOKEN` in `kindgi.env` with it, and
[restart](../restart-and-check-health/#restart-the-runtime).

The `Token` line in the log now shows the new token's last four characters,
and the old token is refused:

```text
{"error":{"code":"auth-missing","message":"Bearer token is not recognized","requestId":"req-…"}}
```

`KINDGI_API_TOKEN` is one token, so switch your CLI and apps to the new one
when you restart.

Console sessions signed in with the old token end at the restart, and
people sign in again. The startup log counts them:

```text
  Signed out: 1 console session an earlier token opened
```

A request with such a session afterwards answers `401`.

## Rotate the pack service token

The runtime and your pack's service share this token. A new one replaces it
on both sides.

Make a new one:

```sh
openssl rand -base64 32
```

It prints 32 random bytes in base64, elided here:

```text
YT0L…qlM=
```

Put it in both files, as `KINDGI_PACK_SERVICE_TOKEN` in `pack.env` and in
`kindgi.env`. Then restart the pack's service with the same image:

```sh
docker stop -t 30 kindgi-pack
docker rm kindgi-pack
docker run -d --name kindgi-pack --network kindgi --env-file pack.env \
  registry.localhost:5050/acme-pack@sha256:<your pack's digest>
```

`<your pack's digest>` is the digest of the pack's image you run now.

Docker prints the container's name after `stop` and `rm`, and the new
container's id after `run`:

```text
kindgi-pack
kindgi-pack
9b39070edcb7a7b20a373c0842207f6fd51db51bc1783f5f0c37eff06e38cdb5
```

And [restart the runtime](../restart-and-check-health/#restart-the-runtime).
While the two tokens differ, the pack's service refuses the runtime's calls,
and your tools fail. The runtime's log says so:

```text
  ⚠ Pack service at http://kindgi-pack:8080 isn't answering (pack-service-unauthorized: The pack service rejected the pack token). The server is up; pack tools and checks fail until it answers.
```

Once both sides have the same token, the runtime's calls go through again,
with no further restart.

## Rotate the license key

A new license key replaces one that expires, or one of another kind.

Replace `KINDGI_LICENSE_KEY` in `kindgi.env` with the new key, and
[restart](../restart-and-check-health/#restart-the-runtime). The `License`
line in the log shows the new key:

```text
  License: Docs example · non-production · until 2026-11-02
```

A deployment can also renew its key itself, as
[Renew the license key](../renew-the-license-key/) shows.

## Rotate a signing key

A new signing key replaces the one your pack's releases are signed with, and
the old one is revoked.

Rotate under a new key id. A key id stays bound to its public key, and a
revoked id can't be trusted again.

1. Create a key:

   ```sh
   npx --yes @kindgi/cli@0.2 key create acme-selfhost-2 --env selfhost
   ```

   `acme-selfhost-2` is the new key's id. `--env selfhost` also prints the
   lines to add to the `selfhost` block of `kindgi.config.ts`. It prints the
   key as JSON, then where it put it and the lines to add, with the home
   folder's path elided:

   ```text
   {
     "keyId": "acme-selfhost-2",
     "privateKeyPath": "…/.kindgi/keys/acme-selfhost-2.pem",
     "publicKeyPath": "…/.kindgi/keys/acme-selfhost-2.pub.pem",
     "fingerprint": "sha256:37c5be5aed8a2688470bdacb",
     "home": "…",
     "env": "selfhost"
   }

     ✓ Ed25519 keypair created: acme-selfhost-2
       private key:  …/.kindgi/keys/acme-selfhost-2.pem  (mode 0600)
       public key:   …/.kindgi/keys/acme-selfhost-2.pub.pem  (mode 0644)
       fingerprint:  sha256:37c5be5aed8a2688470bdacb

     Next step: add to environments.selfhost in kindgi.config.ts:

       selfhost: {
         // …existing fields…
         signingKey: '~/.kindgi/keys/acme-selfhost-2.pem',
         signerKeyId: 'acme-selfhost-2',
       },

     Then `kindgi build --env=selfhost` will pick up the key.
   ```

   Then trust it on the runtime:

   ```sh
   npx --yes @kindgi/cli@0.2 key trust acme-selfhost-2 --url http://localhost:4000
   ```

   `--url` is the runtime's URL. It prints the trusted key as JSON, then
   `✓ Trusted acme-selfhost-2` with the fingerprint `key create` printed:

   ```text
   {
     "keyId": "acme-selfhost-2",
     "tenantId": "7e23b761-8fb2-47a0-925d-15fdf2e90fd7",
     "algorithm": "ed25519",
     "publicKey": "LzdQT9vYe71NqL4/bCozeEkTYqPIAhdZYiCC40xQnmA=",
     "createdAt": "2026-10-12T16:48:46.981Z"
   }

     ✓ Trusted acme-selfhost-2 (sha256:37c5be5aed8a2688470bdacb)
       The runtime now accepts deploys this key signs.
   ```

2. Sign your next release with it. Add the two lines `key create` printed
   to the `selfhost` block of `kindgi.config.ts`:

   ```ts excerpt
   signingKey: '~/.kindgi/keys/acme-selfhost-2.pem',
   signerKeyId: 'acme-selfhost-2',
   ```

   Then build and deploy as usual, and run the new image as your pack's
   service, as [step 4](../self-host/#4-run-your-packs-service) of Self-host
   Kindgi does. The first line keeps the old key's envelope, to check the
   revocation in step 3:

   ```sh
   cp .kindgi/build/deploy-envelope.json old-envelope.json
   pnpm exec kindgi build --local --push --env selfhost
   pnpm exec kindgi deploy --env selfhost
   ```

   The deploy prints the deployment as JSON, then each step. Its registering
   step:

   ```text
   …
     Registering deployment
       ✓ POST /v1/deployments  →  201 Created
         deploymentId:    3c4f4d76-f4a4-4d5f-8339-f05b0497b462
         artifactVersion: 20261008.193855
   …
   ```

   The artifact version is the build time by default, `YYYYMMDD.HHMMSS` in
   UTC, so a second build the same day gets its own tag.

3. Revoke the old key:

   ```sh
   npx --yes @kindgi/cli@0.2 key revoke acme-selfhost --reason "rotated to acme-selfhost-2" \
     --url http://localhost:4000
   ```

   `acme-selfhost` is the old key's id, and `--reason` is kept with the
   revocation. It prints the result as JSON, then two lines:

   ```text
   {
     "keyId": "acme-selfhost",
     "revoked": true
   }

     ✓ Revoked acme-selfhost
       The runtime refuses new deploys it signs. Deployments it signed keep running, and the key stays listed for audit.
   ```

   A revoked id can't be trusted again: `kindgi key trust` says so, and how
   to trust another key.

From then on, the runtime refuses a deploy signed by the old key. Here, an
envelope it signed earlier:

```sh
pnpm exec kindgi deploy --env selfhost --from-envelope old-envelope.json \
  --idempotency-key redeploy-old
```

`--from-envelope` deploys a signed envelope as it is. `--idempotency-key`
gives this deploy its own key. Without it, the CLI's key is a hash of the
envelope, so sending an envelope you already deployed returns the first
answer again, for 24 hours, and deploys nothing.

```text
…
  Registering deployment
    ✗ POST /v1/deployments  →  HTTP 403
      code:    signer-not-trusted
      message: Signer key "acme-selfhost" is not on this tenant's trust list
…
```

The runtime checks signatures when you deploy. A deployment the revoked key
signed keeps running, through restarts too. The revoked key stays listed for
audit:

```sh
curl -s "http://localhost:4000/v1/signing-keys?includeRevoked=true" -H @<(printf 'Authorization: Bearer %s\n' "$KINDGI_API_TOKEN")
```

It answers with the keys as JSON. Each key in the list has its `revokedAt`
and `revokedReason`, if it was revoked:

```text
{"data":[{"keyId":"acme-selfhost","tenantId":"7e23b761-8fb2-47a0-925d-15fdf2e90fd7","algorithm":"ed25519","publicKey":"Fgx7GGmlWq8CTnoSlW3pcHwuLNrozmX3RtAE6R7JWTo=","createdAt":"2026-10-12T16:48:41.774Z","revokedAt":"2026-10-12T16:48:48.236Z","revokedReason":"rotated to acme-selfhost-2"},{"keyId":"acme-selfhost-2","tenantId":"7e23b761-8fb2-47a0-925d-15fdf2e90fd7","algorithm":"ed25519","publicKey":"LzdQT9vYe71NqL4/bCozeEkTYqPIAhdZYiCC40xQnmA=","createdAt":"2026-10-12T16:48:46.981Z"}],"hasMore":false}
```

## Rotate the public run token key

If browsers [follow runs](../../../guides/runs/follow-from-the-browser/), the
runtime signs their public run tokens with a key of its own. A new key
replaces it.

Make one:

```sh
openssl genpkey -algorithm ed25519 -out public-token-signing.pem
chmod 600 public-token-signing.pem
```

Both print nothing. The key is in `public-token-signing.pem`, readable only
by you.

Give it to the runtime as a file. Add this line to `kindgi.env`:

```sh
KINDGI_PUBLIC_TOKEN_SIGNING_KEY_PATH=/etc/kindgi/public-token-signing.pem
```

Then restart with the file mounted:

```sh
docker run -d --name kindgi-server --network kindgi --restart unless-stopped \
  --add-host registry.localhost:host-gateway \
  -v "$PWD/public-token-signing.pem:/etc/kindgi/public-token-signing.pem:ro" \
  -p 127.0.0.1:4000:4000 --env-file kindgi.env \
  quay.io/kindgi/runtime:0.1.9
```

`-v` mounts the key file, read-only, at the path `kindgi.env` names. The
other flags are [the restart's](../restart-and-check-health/#restart-the-runtime).
It prints the new container's id:

```text
bb9217f9a692c0a22b2a5bae10620194f0843fe2de8c01e5c478e2aec51464bb
```

The file must have mode 0600, and the runtime's user in the container, uid
10001, must be able to read it. The log says:

```text
  Public run tokens: on (browsers follow runs; no CORS origins)
```

To rotate it, replace the file with a new key, with the same two commands,
and restart with the same mount. Tokens signed with the old key are refused
from then on:

```text
{"error":{"code":"auth-missing","message":"Bearer token is not recognized","requestId":"req-…"}}
```

Tokens minted after the restart work as before.

## Next

- [Restart the runtime and check its health](../restart-and-check-health/)
- [Renew the license key](../renew-the-license-key/)
- [People, API keys and service accounts](../../people-and-keys/)
- [Operate a self-hosted runtime](../operate/)
