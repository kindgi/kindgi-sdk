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
  ACS URL (single sign-on URL):  http://localhost:18096/auth/sso/saml2/sp/acs/idp-36gw7wxpebo2ncu3v6oxtnowgy
  Entity ID (audience):          http://localhost:18096/auth/sso/saml2/sp/metadata?providerId=idp-36gw7wxpebo2ncu3v6oxtnowgy
  Service provider metadata:     http://localhost:18096/auth/sso/saml2/sp/metadata?providerId=idp-36gw7wxpebo2ncu3v6oxtnowgy
  Name ID: the email address (or an `email` attribute). Sign the assertions.
  Let in only the people who should use Kindgi (assign users or groups).

  Send back: the identity provider's metadata XML.

Step by step: https://docs.kindgi.com/guides/sso/saml/

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

If your identity provider wants signed requests, store Kindgi's signing key
in the secret store and add `--sp-signing-key-ref=<NAME>`.
