---
title: Keycloak
description: Set up sign-in with Keycloak, as an OpenID Connect client or a SAML client, with the exact field names in Keycloak's admin console.
sidebar:
  order: 13
---

When you finish this page, your workspace's people sign in with their
Keycloak accounts, through a client in your realm. The client speaks either
OpenID Connect or SAML. These steps were checked on Keycloak 26.4, with
OpenID Connect and with SAML (signed requests).

## Before you start

- **Sign-in is on for your runtime, and you're an admin of the workspace,**
  with the `kindgi` CLI set up as [Set up SSO](../#before-you-start) says.
- **Admin access to your Keycloak realm,** on Keycloak 26.4 or a release
  whose admin console has the same fields.
- **For SAML, `openssl`,** to make Kindgi's signing key and certificate.
- **For `kindgi` commands:** Kindgi 0.1's CLI, which runs from any folder as
  `npx --yes @kindgi/cli@0.1` ([Install](../../../start/install/)). Inside a
  pack project, `pnpm exec kindgi` runs the project's pinned CLI instead.

## OpenID Connect

### 1. Get the redirect URI

`start` gives you the redirect URI to enter in Keycloak:

```sh
npx --yes @kindgi/cli@0.1 sso providers start acme-kc --idp=keycloak
```

- `acme-kc` is the provider's id in your workspace.
- `--idp=keycloak` adds Keycloak's own steps to the message.

```text
Sign-in with "acme-kc" (OpenID Connect). Send this to whoever runs your identity provider:

  Create an OpenID Connect web application (a confidential client) for Kindgi.
  Redirect URI:  http://localhost:18096/auth/sso/callback/idp-ibhu3tdkkrjjjfllbjpu2uk3gm
  Scopes:        openid email profile
  Let in only the people who should use Kindgi (assign users or groups).

  Send back: the issuer URL and the client ID. The client secret goes into
  Kindgi's secret store under a name, never by email or chat:
    kindgi secrets set <NAME> --env=<runtime env> --scope=tenant

Keycloak admin console → your realm → Clients → Create client → OpenID Connect:
  1. Client authentication: On. Authentication flow: Standard flow.
  2. Valid redirect URIs: the URI above (exactly; no wildcard).
  3. Credentials tab: copy the client secret.
  4. Each person needs an email with "Email verified" on, or sign-in is refused.
Issuer: https://<keycloak-host>/realms/<realm>

Step by step: https://docs.kindgi.com/v0.1/guides/sso/keycloak/

Then register it:
  kindgi sso providers finish acme-kc --kind=oidc --issuer=<issuer> --client-id=<client-id> --client-secret-ref=<NAME> --domains=<your-domain>

These URLs stay the same after registering and after any `update`.
```

### 2. Create the client in Keycloak

In the Keycloak admin console, in your realm, open **Clients → Create
client**, and choose the client type **OpenID Connect**:

1. **On the second step:** turn **Client authentication** On, for a
   confidential client. Choose the **Authentication flow** Standard flow, and
   the **PKCE Method** S256.
2. **On the third step, Valid redirect URIs:** enter the redirect URI that
   `start` printed, exactly, with no wildcard.
3. **On the client's Credentials tab:** copy the **Client secret**.
4. **For each person:** turn **Email verified** On, under Users → the person
   → Details. Without it, Kindgi refuses their sign-in: "Your email isn't
   verified".

### 3. Store the client secret

Store the secret in Kindgi's secret store, by name, so it never travels by
email or chat:

```sh
npx --yes @kindgi/cli@0.1 secrets set ACME_KC_SECRET --env=production --scope=tenant
```

- `ACME_KC_SECRET` is the secret's name. The registration keeps only this
  name.
- `--env` is the runtime's environment, its `KINDGI_ENV`.
- `--scope=tenant` stores the secret for the whole workspace.

The command asks for the value twice, and doesn't show what you type.
Then it prints what it stored:

```text
Value:
Re-enter to confirm:
{
  "name": "ACME_KC_SECRET",
  "scope": {
    "kind": "tenant",
    "tenantId": "6c0bd33e-e941-439b-bd0c-c7e412db29fc"
  },
  "envName": "production",
  "versionId": 1
}

  Set ACME_KC_SECRET at tenant in production.
```

### 4. Register it

`finish` registers the client, and offers it to people at your domains:

```sh
npx --yes @kindgi/cli@0.1 sso providers finish acme-kc --kind=oidc --issuer=https://<keycloak-host>/realms/<realm> \
  --client-id=<client id> --client-secret-ref=ACME_KC_SECRET --domains=<your domain>
```

- `--issuer` is your realm's URL. `<keycloak-host>` is your Keycloak's
  address, and `<realm>` the realm's name.
- `<client id>` is the client's **Client ID** from step 2.
- `--client-secret-ref` is the secret's name from step 3.
- `<your domain>` is your organization's email domain, such as `acme.com`.
  For more than one, separate them with commas.

`finish` prints the registration
([Set up SSO](../#3-register-what-it-sent-back) shows one).

## SAML

Keycloak's SAML metadata always asks for signed sign-in requests. So a
Keycloak SAML client needs a signing key and certificate for Kindgi.

### 1. Get the SAML URLs

`start` with `--kind=saml` gives you the URLs a SAML client asks for:

```sh
npx --yes @kindgi/cli@0.1 sso providers start acme-saml --kind=saml
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

### 2. Make Kindgi's signing key and certificate

Kindgi signs its sign-in requests with this key, and Keycloak checks them
with the certificate. Make both, and store the key in Kindgi's secret store
by name:

```sh
openssl req -x509 -newkey rsa:2048 -nodes -keyout acme-sp-key.pem -out acme-sp-cert.pem -days 730 -subj "/CN=Kindgi SAML (acme.test)"
npx --yes @kindgi/cli@0.1 secrets set ACME_SAML_SIGNING_KEY --env=production --scope=tenant --from-stdin < acme-sp-key.pem
```

- `req -x509` makes a self-signed certificate, and `-newkey rsa:2048` a new
  2048-bit RSA key for it.
- `-nodes` leaves the key file unencrypted, so Kindgi can read it.
- `-keyout` and `-out` name the key's file and the certificate's file.
- `-days 730` makes the certificate last two years.
- `-subj` sets the certificate's name. Use your own domain in it.
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

Give the certificate, `acme-sp-cert.pem`, to whoever runs Keycloak. The key
stays in the secret store. Delete `acme-sp-key.pem` once it's stored.

### 3. Create the client in Keycloak

In your realm, open **Clients → Create client**, and choose the client type
**SAML**. Then:

1. **On the client's Settings tab:**
   - **Client ID:** enter the entity ID that `start` printed. Keycloak uses
     the client ID as the service provider's entity ID.
   - **Valid redirect URIs:** enter the ACS URL that `start` printed.
   - **Name ID format:** choose email, and turn **Force name ID format** On.
   - **Sign assertions:** turn it On.
2. **On the Advanced tab, Assertion Consumer Service POST Binding URL:**
   enter the ACS URL again.
3. **On the Keys tab, under "Signing keys config":** turn **Client signature
   required** On, and import Kindgi's certificate, `acme-sp-cert.pem`.
   Keycloak can also read keys from a service provider's metadata URL. But
   Kindgi's metadata doesn't carry the certificate, so import it.
4. **On the client's Client scopes tab:** open its dedicated scope,
   `<client id>-dedicated`. Then choose **Add mapper → By configuration →
   User Property**, with the **Property** `email` and the **SAML Attribute
   Name** `email`.

### 4. Save the realm's metadata

The realm's metadata is under **Realm settings → General → Endpoints → SAML
2.0 Identity Provider Metadata**. Save it to a file:

```sh
curl -fsS -o acme-idp-metadata.xml https://<keycloak-host>/realms/<realm>/protocol/saml/descriptor
```

- `-fsS` fails on an HTTP error, and prints only errors.
- `-o` names the file to save it to.
- `<keycloak-host>` is your Keycloak's address, and `<realm>` the realm's
  name.

### 5. Register it

`finish` registers the client with its metadata and the signing key's name:

```sh
npx --yes @kindgi/cli@0.1 sso providers finish acme-saml --kind=saml --idp-metadata=@acme-idp-metadata.xml \
  --domains=acme.test --sp-signing-key-ref=ACME_SAML_SIGNING_KEY --name="Acme SAML"
```

- `--idp-metadata=@<file>` reads the realm's metadata from the file. The
  `@` is required.
- `--domains` are the email domains this provider is offered for.
- `--sp-signing-key-ref` is the signing key's name from step 2.
- `--name` is what the sign-in page's button says: "Sign in with Acme SAML".

Without `--sp-signing-key-ref`, `finish` refuses:

```text
Error [identity-provider-invalid]: The identity provider wants signed sign-in requests (its metadata says WantAuthnRequestsSigned="true"): make a signing key and certificate, give IT the certificate, put the key (PEM) in the secret store, and set `spSigningKeyRef` to its name
```

## Keycloak on a private network

Kindgi refuses a Keycloak that the runtime reaches only on a private
address, unless the runtime's operator allows its origin with
`KINDGI_AUTH_PRIVATE_IDP_ORIGINS`
([Turn on sign-in](../../../deploy/self-hosted/sign-in/)):

```text
Error [identity-provider-invalid]: http://127.0.0.1:18091/realms/acme is not a public HTTPS address (loopback): the deployment's operator can allow its origin with KINDGI_AUTH_PRIVATE_IDP_ORIGINS
```

## Next

- [Add people, and try it](../#4-add-people-and-try-it): only people you've
  added get in.
- [Sign in to the console](../sign-in/): what your people see.
- [Change it, list it, remove it](../#change-it-list-it-remove-it).
