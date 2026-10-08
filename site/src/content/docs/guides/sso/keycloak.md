---
title: Keycloak
description: Set up sign-in with Keycloak, as an OpenID Connect client or a SAML client, with the exact field names in Keycloak's admin console.
sidebar:
  order: 13
---

These steps were checked on Keycloak 26.4, with OpenID Connect and with
SAML. Start with [Set up SSO](../), which gives you the redirect URI or the
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

```sh
kindgi sso providers start acme-kc-saml --kind=saml
```

In your realm, **Clients → Create client**, client type **SAML**:

1. **Client ID:** the SP entity ID `start` printed. Keycloak uses the client
   ID as the service provider's entity ID.
2. **Assertion Consumer Service POST Binding URL:** the ACS URL `start`
   printed. Put the same URL in **Valid redirect URIs**.
3. **Sign assertions:** On.
4. **Name ID format:** email, with **Force name ID format** On.
5. **Client scopes → the client's dedicated scope → Add mapper → By
   configuration → User Property:** property `email`, SAML attribute name
   `email`.
6. **Client signature required:** On, with Kindgi's signing certificate on
   the client's **Keys** tab. Keycloak's metadata then asks for signed
   requests. Store Kindgi's signing key in the secret store, and register it
   with `--sp-signing-key-ref`.

Keycloak's metadata for the realm is at
`https://<keycloak-host>/realms/<realm>/protocol/saml/descriptor`. Save it,
then:

```sh
kindgi sso providers finish acme-kc-saml --kind=saml --idp-metadata=@keycloak-metadata.xml --domains=<your domain>
```

## Keycloak on a private network

A Keycloak the runtime reaches only on a private address is refused unless
the runtime's operator allows its origin with `KINDGI_AUTH_PRIVATE_IDP_ORIGINS`
([Turn on sign-in](../../../deploy/sign-in/)):

```text
Error [identity-provider-invalid]: http://127.0.0.1:18091/realms/acme is not a public HTTPS address (loopback): the deployment's operator can allow its origin with KINDGI_AUTH_PRIVATE_IDP_ORIGINS
```
