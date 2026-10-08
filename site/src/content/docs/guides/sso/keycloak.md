---
title: Keycloak
description: Set up sign-in with Keycloak, as an OpenID Connect client or a SAML client, with the exact field names in Keycloak's admin console.
sidebar:
  order: 13
---

These steps were checked on Keycloak 26.4, with OpenID Connect and with
SAML (signed requests). Start with [Set up SSO](../), which gives you the redirect URI or the
SAML URLs to use here.

## OpenID Connect

```sh
kindgi sso providers start acme-kc --idp=keycloak
```

In the Keycloak admin console, in your realm, **Clients → Create client**,
client type **OpenID Connect**:

1. **Client authentication:** On (a confidential client). **Authentication
   flow:** Standard flow.
2. **Valid redirect URIs:** the redirect URI `start` printed, exactly, with no
   wildcard.
3. **Proof Key for Code Exchange Code Challenge Method:** S256.
4. On the client's **Credentials** tab, copy the **Client secret**, and store
   it in Kindgi by name:

   ```sh
   kindgi secrets set ACME_KC_SECRET --env=production --scope=tenant --from-stdin
   ```

5. **Each person needs an email with "Email verified" on** (Users → the
   person → Details). Without it, sign-in is refused: "Your email isn't
   verified".

The issuer is your realm's URL, `https://<keycloak-host>/realms/<realm>`.
Then:

```sh
kindgi sso providers finish acme-kc --kind=oidc --issuer=https://<keycloak-host>/realms/<realm> \
  --client-id=<client id> --client-secret-ref=ACME_KC_SECRET --domains=<your domain>
```

## SAML

Keycloak's SAML metadata always asks for signed sign-in requests, so a
Keycloak SAML client needs a signing key and certificate for Kindgi. Start
with `--kind=saml` ([SAML](../saml/) shows what it prints):

```sh
kindgi sso providers start acme-saml --kind=saml
```

1. **Make Kindgi's signing key and certificate,** and put the key in Kindgi's
   secret store by name:

   ```sh
   openssl req -x509 -newkey rsa:2048 -nodes -keyout acme-sp-key.pem -out acme-sp-cert.pem -days 730 -subj "/CN=Kindgi SAML (acme.test)"
   kindgi secrets set ACME_SAML_SIGNING_KEY --env=production --scope=tenant --from-stdin < acme-sp-key.pem
   ```

   Give IT the certificate, `acme-sp-cert.pem`. The key stays in the secret
   store.

2. In your realm, **Clients → Create client**, client type **SAML**. On the
   client's **Settings** tab:
   - **Client ID:** the entity ID `start` printed. Keycloak uses the client ID
     as the service provider's entity ID.
   - **Valid redirect URIs** and **Assertion Consumer Service POST Binding
     URL:** the ACS URL `start` printed.
   - **Name ID format:** email, with **Force name ID format** On.
   - **Sign assertions:** On.
3. On the **Keys** tab ("Signing keys config"): **Client signature
   required** On, and import Kindgi's certificate, `acme-sp-cert.pem`.
   (Keycloak can also read keys from a service provider's metadata URL, but
   Kindgi's metadata doesn't carry the certificate yet: import it.)
4. On the client's **Client scopes** tab, open its dedicated scope
   (`<client id>-dedicated`), then **Add mapper → By configuration → User
   Property**: **Property** `email`, **SAML Attribute Name** `email`.

The realm's metadata is at
`https://<keycloak-host>/realms/<realm>/protocol/saml/descriptor`. Save it,
and finish with the signing key's name:

```sh
kindgi sso providers finish acme-saml --kind=saml --idp-metadata=@acme-idp-metadata.xml \
  --domains=acme.test --sp-signing-key-ref=ACME_SAML_SIGNING_KEY --name="Acme SAML"
```

Without `--sp-signing-key-ref`, `finish` refuses:

```text
Error [identity-provider-invalid]: The identity provider wants signed sign-in requests (its metadata says WantAuthnRequestsSigned="true"): make a signing key and certificate, give IT the certificate, put the key (PEM) in the secret store, and set `spSigningKeyRef` to its name
```

## Keycloak on a private network

A Keycloak the runtime reaches only on a private address is refused unless
the runtime's operator allows its origin with `KINDGI_AUTH_PRIVATE_IDP_ORIGINS`
([Turn on sign-in](../../../deploy/sign-in/)):

```text
Error [identity-provider-invalid]: http://127.0.0.1:18091/realms/acme is not a public HTTPS address (loopback): the deployment's operator can allow its origin with KINDGI_AUTH_PRIVATE_IDP_ORIGINS
```
