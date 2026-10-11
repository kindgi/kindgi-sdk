---
title: Another SAML provider
description: Set up sign-in with a SAML 2.0 identity provider your workspace owns, and what Kindgi needs from it.
sidebar:
  order: 15
  label: SAML
---

Any SAML 2.0 identity provider works. Start with [Set up SSO](../), with
`--kind=saml`:

```sh
kindgi sso providers start acme-saml --kind=saml
```

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

## What Kindgi needs from it

- **A SAML app** with the ACS URL and the entity ID (audience) `start`
  printed. Many identity providers can read both from Kindgi's service
  provider metadata URL instead.
- **The person's email** as the Name ID, or in an `email` attribute.
- **Signed assertions.**
- **Only the people who should use Kindgi** assigned to the app (users or
  groups).

Send back the identity provider's metadata XML. Then:

```sh
kindgi sso providers finish acme-saml --kind=saml --idp-metadata=@idp-metadata.xml --domains=<your domain>
```

## When your identity provider wants signed requests

If its metadata says `WantAuthnRequestsSigned="true"` (Keycloak's always
does), Kindgi must sign its sign-in requests, and `finish` refuses without a
key:

```text
Error [identity-provider-invalid]: The identity provider wants signed sign-in requests (its metadata says WantAuthnRequestsSigned="true"): make a signing key and certificate, give IT the certificate, put the key (PEM) in the secret store, and set `spSigningKeyRef` to its name
```

Make a key and certificate, store the key by name, and give IT the
certificate to add to the app:

```sh
openssl req -x509 -newkey rsa:2048 -nodes -keyout acme-sp-key.pem -out acme-sp-cert.pem -days 730 -subj "/CN=Kindgi SAML (acme.test)"
kindgi secrets set ACME_SAML_SIGNING_KEY --env=production --scope=tenant --from-stdin < acme-sp-key.pem
```

Then finish with `--sp-signing-key-ref=ACME_SAML_SIGNING_KEY`. Kindgi's
service provider metadata doesn't carry the certificate yet, so IT adds it
to the app by hand. [Keycloak](../keycloak/#saml) has the steps, checked
end to end.
