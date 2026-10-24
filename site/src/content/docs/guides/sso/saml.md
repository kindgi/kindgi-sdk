---
title: Another SAML provider
description: Set up sign-in with a SAML 2.0 identity provider your workspace owns, and what Kindgi needs from it.
sidebar:
  order: 15
  label: SAML
---

When you finish this page, your workspace's people sign in through any SAML
2.0 identity provider. The page also lists what Kindgi needs from that
provider.

## Before you start

- **Sign-in is on for your runtime, and you're an admin of the workspace,**
  with the `kindgi` CLI set up as [Set up SSO](../#before-you-start) says.
- **Someone who can create a SAML app in your identity provider.**
- **`openssl`,** if your identity provider wants signed sign-in requests
  ([When your identity provider wants signed requests](#when-your-identity-provider-wants-signed-requests)).
- **For `kindgi` commands:** Kindgi 0.2's CLI, which runs from any folder as
  `npx --yes @kindgi/cli@0.2` ([Install](../../../start/install/)). Inside a
  pack project, `pnpm exec kindgi` runs the project's pinned CLI instead.

## 1. Get the SAML URLs

`start` with `--kind=saml` gives you the URLs a SAML app asks for:

```sh
npx --yes @kindgi/cli@0.2 sso providers start acme-saml --kind=saml
```

- `acme-saml` is the provider's id in your workspace.
- `--kind=saml` asks for a SAML provider's URLs: its ACS URL and its entity
  ID.

```text
Sign-in with "acme-saml" (SAML). Send this to whoever runs your identity provider:

  Create a SAML 2.0 application for Kindgi.
  ACS URL (single sign-on URL):  http://localhost:18096/auth/sso/saml2/sp/acs/idp-o2ff6ocaeflrtl4qeknbutvlru
  Entity ID (audience):          http://localhost:18096/auth/sso/saml2/sp/metadata?providerId=idp-o2ff6ocaeflrtl4qeknbutvlru
  Service provider metadata:     http://localhost:18096/auth/sso/saml2/sp/metadata?providerId=idp-o2ff6ocaeflrtl4qeknbutvlru
  Name ID: the email address (or an `email` attribute). Sign the assertions.
  Let in only the people who should use Kindgi (assign users or groups).

  Send back: the identity provider's metadata XML.

Step by step: https://docs.kindgi.com/v0.1/guides/sso/saml/

Then register it:
  kindgi sso providers finish acme-saml --kind=saml --idp-metadata=@<metadata.xml> --domains=<your-domain>

These URLs stay the same after registering and after any `update`.
```

## 2. Create the app in your identity provider

Kindgi needs these from the app:

- **The ACS URL and the entity ID that `start` printed.** The entity ID is
  also called the audience. Many identity providers can read both from
  Kindgi's service provider metadata URL instead.
- **The person's email** as the Name ID, or in an `email` attribute.
- **Signed assertions.**
- **Only the people who should use Kindgi,** assigned to the app as users or
  groups.

Save the identity provider's metadata XML to a file, such as
`idp-metadata.xml`.

## 3. Register it

`finish` registers the app with its metadata, and offers it to people at
your domains:

```sh
npx --yes @kindgi/cli@0.2 sso providers finish acme-saml --kind=saml --idp-metadata=@idp-metadata.xml --domains=<your domain>
```

- `--kind=saml` says the provider speaks SAML.
- `--idp-metadata=@<file>` reads the identity provider's metadata from the
  file. The `@` is required.
- `<your domain>` is your organization's email domain, such as `acme.com`.
  For more than one, separate them with commas.

`finish` prints the registration, as in
[Set up SSO](../#3-register-what-it-sent-back).

## When your identity provider wants signed requests

If the metadata says `WantAuthnRequestsSigned="true"`, Kindgi must sign its
sign-in requests. Keycloak's metadata always says so. `finish` then refuses
without a key:

```text
Error [identity-provider-invalid]: The identity provider wants signed sign-in requests (its metadata says WantAuthnRequestsSigned="true"): make a signing key and certificate, give IT the certificate, put the key (PEM) in the secret store, and set `spSigningKeyRef` to its name
```

Make a key and certificate, and store the key in Kindgi's secret store by
name:

```sh
openssl req -x509 -newkey rsa:2048 -nodes -keyout acme-sp-key.pem -out acme-sp-cert.pem -days 730 -subj "/CN=Kindgi SAML (acme.test)"
npx --yes @kindgi/cli@0.2 secrets set ACME_SAML_SIGNING_KEY --env=production --scope=tenant --from-stdin < acme-sp-key.pem
```

- `req -x509` makes a self-signed certificate, and `-newkey rsa:2048` a new
  2048-bit RSA key for it.
- `-nodes` leaves the key file unencrypted, so Kindgi can read it.
- `-keyout` and `-out` name the key's file and the certificate's file.
- `-days 730` makes the certificate last two years.
- `-subj` sets the certificate's name. Use your own domain in it.
- `--env` is the runtime's environment, its `KINDGI_ENV`, and
  `--scope=tenant` stores the key for the whole workspace.
- `--from-stdin` makes `set` read the key from its input, instead of asking
  for it. `< acme-sp-key.pem` gives it the key file as that input.

`openssl` prints its progress, then a line of dashes. Then `set` prints what
it stored:

```text
…
-----
{
  "name": "ACME_SAML_SIGNING_KEY",
  "scope": {
    "kind": "tenant",
    "tenantId": "6c0bd33e-e941-439b-bd0c-c7e412db29fc"
  },
  "envName": "production",
  "versionId": 1
}

  Set ACME_SAML_SIGNING_KEY at tenant in production.
```

Give the certificate, `acme-sp-cert.pem`, to whoever runs your identity
provider, to add to the app. Kindgi's service provider metadata doesn't
carry the certificate, so they add it by hand. Then run `finish` again with
the key's name:

```sh
npx --yes @kindgi/cli@0.2 sso providers finish acme-saml --kind=saml --idp-metadata=@idp-metadata.xml --domains=<your domain> \
  --sp-signing-key-ref=ACME_SAML_SIGNING_KEY
```

`--sp-signing-key-ref` is the signing key's name in the secret store.
[Keycloak](../keycloak/#saml) has these steps for one identity provider,
checked end to end.

## Next

- [Add people, and try it](../#4-add-people-and-try-it): only people you've
  added get in.
- [Sign in to the console](../sign-in/): what your people see.
- [Change it, list it, remove it](../#change-it-list-it-remove-it).
