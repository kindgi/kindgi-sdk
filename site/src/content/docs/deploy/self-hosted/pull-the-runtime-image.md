---
title: Pull the runtime image
description: Pull Kindgi's runtime image from registry.kindgi.com with your license key, by hand, from CI, or into your own registry.
sidebar:
  order: 1.5
---

When you finish this page, Docker (or another registry client) can pull
Kindgi's runtime image with your license key.

The runtime is a container image at `registry.kindgi.com/kindgi/runtime`,
tagged with each release's version. Your license key is its password. There's
no separate pull credential.

## Get a key

Sign in at [access.kindgi.com](https://access.kindgi.com) with GitHub or with
your email address. It gives you a free non-production key, which starts with
`kgi_lk_`. That key pulls the image, and runs the runtime outside development
mode, for staging and CI ([Licensing](../../../concepts/licensing/)). A
production key, which comes with a commercial license from contact@kindgi.com,
pulls the image too.

### Sign in with your email address

1. On [access.kindgi.com](https://access.kindgi.com), enter your address to
   have a code emailed to you.
2. The code is 6 digits, from `no-reply@access.kindgi.com`. It works for 10
   minutes. The email has no link: you type the code in the same browser
   where you asked for it.
3. Enter the code. After 5 wrong tries, that code stops working; ask for a new
   one.

- **Use a work or personal address.** A throwaway address is refused.
- **One address is one person.** If you've signed in with GitHub before, the
  address that's your GitHub account's primary verified email signs you in as
  that same person, with the same key.
- **No code?** Check your spam folder, wait a minute and ask again. If it
  still doesn't come, write to contact@kindgi.com.

### Your key's name

Everyone gets their own key, at a company too. The runtime prints the key's
name when it starts, so the name is chosen to be safe in shared logs:

- **A company address** (yours, or your GitHub account's primary verified
  email): the company's domain, such as `acme.com`. Everyone at `acme.com`
  has their own key with that name. One person's key can be revoked without
  touching anyone else's.
- **An address at a public email service:** the address with everything
  before the `@` cut to its first character, such as `a***@example.com`.
- **GitHub, with a public address:** your GitHub login.

## Log in to the registry

The username is `kindgi`, and the password is your key. With Docker:

```sh
docker login registry.kindgi.com --username kindgi
```

It asks for the password: paste your key. It prints `Login Succeeded`.

From a script or CI, read the key from a file or your secrets store on
standard input:

```sh
docker login registry.kindgi.com --username kindgi --password-stdin < kindgi-license-key.txt
```

Never pass the key with `--password` (`-p`): a command line can end up in your
shell's history and in the list of running processes.

Other clients log in the same way, with `--password-stdin`:

- **Podman:** `podman login registry.kindgi.com --username kindgi --password-stdin`.
  On Linux it keeps the login in `$XDG_RUNTIME_DIR/containers/auth.json`,
  which is gone after a reboot.
- **crane:** `crane auth login registry.kindgi.com --username kindgi --password-stdin`.
- **Kubernetes:** an image pull secret of type
  `kubernetes.io/dockerconfigjson` for `registry.kindgi.com`. Make it from a
  file, so the key isn't on a command line, and update it when the key renews:
  a node can't pull with an expired key.

Docker keeps the login in your system's credential store when it has one
(the macOS Keychain, Windows Credential Manager, or `pass` or Secret Service on
Linux). Without one, it writes the key to `~/.docker/config.json`, only
base64-encoded, so anyone who can read that file can read the key.

## Pull

```sh
docker pull registry.kindgi.com/kindgi/runtime:0.1.11
```

`docker pull` prints the image's digest when it's done. The image is built
for `amd64` and `arm64`, and Docker pulls the one for your machine.

`registry.kindgi.com` has Kindgi 0.1.11 and later.

## Copy it into your own registry

Cloud Run and Azure Container Apps can't pull with a password. Their pages
copy the image into your own registry first, by digest, with every platform
it was built for:

```sh
docker buildx imagetools create --tag "$REPO/runtime:0.1.11" \
  registry.kindgi.com/kindgi/runtime:0.1.11
```

`REPO` is your registry and repository. `crane copy` does the same. A plain
`docker pull`, `tag` and `push` copies only your machine's platform. The
deployment pages copy by digest, and a deployment then runs from your copy, so
a key's expiry never stops it. See
[Cloud Run](../cloud-run/#2-the-images-into-artifact-registry) and
[Azure Container Apps](../azure-container-apps/#2-the-images-into-the-registry).

## Which keys pull

- **Both kinds:** a production key and a non-production key pull the same
  image.
- **For as long as the runtime would start with it:** until 14 days after the
  key's expiry date ([When a key expires](../../../concepts/licensing/#when-a-key-expires)).
  After that, sign in at access.kindgi.com again for a renewed non-production
  key, or renew a production key through contact@kindgi.com, and log in again
  with the new key.
- **Not once it's revoked.** A revoked key stops pulling within a few minutes.

`kindgi dev` pulls the image only when it isn't on your machine yet. So an
expired key shows up when a new CLI pins a new image, not every day.

## When a pull is refused

Docker prints the registry's reason after `unauthorized:`:

- **No key, or not a Kindgi key:** sign in at access.kindgi.com for one, then
  log in.
- **An expired key:** the message gives the date it expired. Get a renewed key
  and log in again.
- **A revoked key:** write to contact@kindgi.com.

After many failed logins from one address in a minute, the registry answers
`429 Too Many Requests` for a while. Wait a minute and try again with the
right key.
