---
title: Check the database's certificate
description: How the runtime encrypts its connection to Postgres, and how to have it check that the server it reached is your database, by Cloud SQL's socket, by a DNS name, or by an IP address with the server's CA.
sidebar:
  order: 3.7
---

This page shows how the runtime's connection to Postgres is encrypted, and
how to have the runtime check that the server it reached is your database.

The runtime connects with `KINDGI_DATABASE_URL`. Its `sslmode` decides
whether the connection is encrypted and what the runtime checks:

| `sslmode` in the URL | Encrypted | What the runtime checks |
| --- | --- | --- |
| none, or `disable` | no | nothing |
| `prefer` | when the server offers TLS | nothing |
| `require`, `allow` | yes, or no connection | nothing |
| `verify-ca`, `verify-full` | yes, or no connection | that the certificate chains to a CA Node trusts, is in date, and names the host connected to |

`require` encrypts the connection but takes any certificate, so on its own
it doesn't stop a server that only claims to be yours. The runtime's
client has no `verify-ca` that checks the CA alone: without the setting
below, `verify-ca` checks the name as `verify-full` does. Leave
`sslrootcert` out of the URL: the client passes it on to Postgres, which
refuses it as a connection parameter.

Which check fits depends on how the runtime reaches the server:

- **[On Cloud Run, through Cloud SQL's socket](#on-cloud-run-through-cloud-sqls-socket):**
  nothing to set.
- **[By a DNS name the certificate gives](#by-a-dns-name):**
  `sslmode=verify-full`.
- **[By an IP address](#by-an-ip-address-with-the-servers-ca):** the
  server's CA, in `KINDGI_DATABASE_SERVER_CA_PATH` or
  `KINDGI_DATABASE_SERVER_CA` (runtime 0.2.0 or later).

## On Cloud Run, through Cloud SQL's socket

[Deploy on Google Cloud Run](../cloud-run/) connects through the socket
Cloud Run mounts at `/cloudsql`: the URL is
`postgres://kindgi:<password>@/kindgi?host=/cloudsql/<connection name>`.
Cloud Run runs the Cloud SQL Auth Proxy behind that socket. Google says
"These connections are automatically encrypted without any additional
configuration" ([Connect from Cloud Run](https://docs.cloud.google.com/sql/docs/postgres/connect-run)),
and that the proxy "automatically encrypts traffic to and from the
database using TLS 1.3", with certificates that "verify client and server
identities" ([About the Cloud SQL Auth Proxy](https://docs.cloud.google.com/sql/docs/postgres/sql-proxy)).

There's nothing to set. The socket itself has no TLS, so the runtime
refuses a server CA with a socket URL, at boot.

## By a DNS name

When the server's certificate names the host in the URL, and a CA that
Node trusts signed it, `sslmode=verify-full` checks the chain, the dates
and the name:

```sh
KINDGI_DATABASE_URL=postgres://kindgi:<DB_PASSWORD>@db.acme.example:5432/kindgi?sslmode=verify-full
```

When your own CA signed it, give that CA with
`KINDGI_DATABASE_SERVER_CA_PATH` too, as the next section shows: the
runtime then checks the chain against that CA alone, and still checks the
name, since the URL says `verify-full`.

On Cloud SQL, a certificate names the instance's DNS name with the shared
CA or a customer-managed CA, and with the per-instance CA only for an
instance with Private Service Connect
([Google: SSL/TLS certificates](https://docs.cloud.google.com/sql/docs/postgres/authorize-ssl)).

## By an IP address, with the server's CA

A certificate rarely names an IP address. When yours does,
`sslmode=verify-full` checks the address as it checks a name (runtime
0.2.0 or later), and the [section above](#by-a-dns-name) applies. When
it doesn't, give the runtime the CA that signed the server's certificate.
It then checks that the certificate chains to that CA and is in date, and
not the name.

Checking the CA alone is enough only when the CA signs this one server's
certificate. Cloud SQL's per-instance CA, the default, does: "Verifying
the CA verifies the server identity since each instance has a unique CA"
([Google: SSL/TLS certificates](https://docs.cloud.google.com/sql/docs/postgres/authorize-ssl)).
A CA that signs other servers' certificates too, such as a shared CA, a
public one or your company's, doesn't: reach the server by its DNS name
with `sslmode=verify-full` instead.

1. **Get the CA.** For Cloud SQL by private IP, every CA the instance
   trusts, the one in use and any added for a rotation
   ([Google: manage SSL/TLS](https://docs.cloud.google.com/sql/docs/postgres/manage-ssl-instance)):

   ```sh
   gcloud sql ssl server-ca-certs list --instance=<instance> \
     --format="value(cert)" > database-ca.pem
   ```

2. **Give it to the runtime,** by one of two settings, never both:
   - **`KINDGI_DATABASE_SERVER_CA_PATH`:** the file's absolute path, in a
     container a file you mount, such as
     `-v "$PWD/database-ca.pem:/etc/kindgi/database-ca.pem:ro"`.
   - **`KINDGI_DATABASE_SERVER_CA`:** the certificates themselves, for a
     platform that gives settings as environment variables. A Docker
     `--env-file` can't hold the several lines a certificate has: use the
     file there.

   The URL keeps `sslmode=require`, or `verify-ca`, which reads the same
   with a CA given:

   ```sh
   KINDGI_DATABASE_URL=postgres://kindgi:<DB_PASSWORD>@10.20.0.3:5432/kindgi?sslmode=require
   KINDGI_DATABASE_SERVER_CA_PATH=/etc/kindgi/database-ca.pem
   ```

3. **Check the boot.** The startup banner says what's checked, with your
   file's path:

   ```text
     Database TLS: the server's certificate must chain to the CA in …/database-ca.pem (KINDGI_DATABASE_SERVER_CA_PATH) and be in date; its name isn't checked
   ```

With a CA given, every connection the runtime makes to its database uses
TLS, whatever the URL's `sslmode` says, and is refused when the server
offers no TLS. A certificate the CA didn't sign, or one out of date, stops
the boot (exit code 1):

```text
Can't connect to the database at …: UNABLE_TO_VERIFY_LEAF_SIGNATURE. Check KINDGI_DATABASE_URL and KINDGI_DATABASE_SERVER_CA_PATH (the CA that signed the server's certificate), and that Postgres is up and reachable from here.
```

The runtime refuses to start (exit code 2) when both settings are set, or
when a CA is given with a URL that reaches a Unix socket or turns TLS off
(`sslmode=disable`, `ssl=false`). So do
`kindgi-runtime check`, `kindgi-runtime tenants` and
`kindgi-runtime erasures`, which open the same database.

The [Cloud Run module](https://github.com/kindgi/kindgi-sdk/tree/main/deploy/gcp-cloud-run)
does all of this in private-IP mode (`database_private_network`): it sets
`KINDGI_DATABASE_SERVER_CA` to the instance's CAs at each apply.

### Rotate the server's CA

The runtime reads the CA when it starts, so it must trust the new CA before
the server presents a certificate it signed. On Cloud SQL:

1. `gcloud sql ssl server-ca-certs create --instance=<instance>` adds the
   new CA.
2. Get the CAs again, as in step 1 above (the file now holds both), and
   restart the runtime with it. With the Cloud Run module, apply.
3. `gcloud sql ssl server-ca-certs rotate --instance=<instance>` moves the
   instance to the new CA.

Restarting after the rotation instead is too late: until the runtime has
the new CA, it refuses the server's new certificate.
