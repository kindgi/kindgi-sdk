---
title: Check the database's certificate
description: How the runtime, and OpenFGA next to it, encrypt their connections to Postgres, and how to have each check that the server it reached is your database, by Cloud SQL's socket, by a DNS name, or by an IP address with the server's CA.
sidebar:
  order: 3.7
---

This page shows how the runtime's connection to Postgres is encrypted, and
how to have the runtime check that the server it reached is your database.
OpenFGA, when you run it for authorization, connects with
[settings of its own](#openfgas-connection-to-the-database).

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
   restart the runtime with it (with the Cloud Run module, apply), and
   OpenFGA too if it checks the CA
   ([below](#openfgas-connection-to-the-database)).
3. `gcloud sql ssl server-ca-certs rotate --instance=<instance>` moves the
   instance to the new CA.

Restarting after the rotation instead is too late: until the runtime has
the new CA, it refuses the server's new certificate.

## OpenFGA's connection to the database

With [authorization](../authorization/) on, OpenFGA keeps its data in
Postgres too, over a connection of its own: the runtime's settings on this
page don't reach it. OpenFGA's datastore URI (`--datastore-uri`, or
`OPENFGA_DATASTORE_URI`) has its own `sslmode`, and takes the server's CA as
a file, in `sslrootcert`. `migrate` and `run` read it the same way. This is
what OpenFGA v1.22.0 checks:

| In OpenFGA's datastore URI | Encrypted | What OpenFGA checks |
| --- | --- | --- |
| no `sslmode`, or `prefer` | when the server offers TLS | nothing |
| `sslmode=require` | yes, or no connection | nothing |
| `sslmode=require` or `verify-ca`, with `sslrootcert=<file>` | yes, or no connection | that the certificate chains to a CA in the file and is in date, not the name |
| `sslmode=verify-ca`, with no `sslrootcert` | yes, or no connection | that the certificate chains to a CA the system trusts, not the name |
| `sslmode=verify-full` | yes, or no connection | that the certificate chains to a CA in the `sslrootcert` file, or without one to a CA the system trusts, and is in date, and that it names the host in the URI, a DNS name or an IP address |
| `sslrootcert=system`, whatever `sslmode` says, `disable` too | yes, or no connection | as `verify-full`, against the CAs the system trusts |

Unlike the runtime's URL, OpenFGA's takes `sslrootcert`, and with it
`require` checks the CA as `verify-ca` does.

Which to use depends on how OpenFGA reaches the server, as for the runtime:

- **Through Cloud SQL's socket,** with OpenFGA on Cloud Run: nothing to set.
  The URI is
  `postgres://kindgi:<DB_PASSWORD>@/openfga?host=/cloudsql/<connection name>`.
- **By a DNS name the certificate gives:** `sslmode=verify-full`, and
  `sslrootcert=<file>` too when your own CA signed the certificate.
- **By an IP address:** `sslmode=verify-ca`, with the server's CA in
  `sslrootcert`. It's the file from
  [step 1 above](#by-an-ip-address-with-the-servers-ca), and, as there,
  checking the CA alone is enough only when the CA signs this one server's
  certificate. `verify-full` fails by an address the certificate doesn't
  name. For a certificate that names no address at all, the error is
  `x509: cannot validate certificate for … because it doesn't contain any IP
  SANs`.

By an IP address, mount the CA file into OpenFGA's container and name it in
the URI, for `migrate` and for `run`:

```sh
docker run --rm --network kindgi \
  -v "$PWD/database-ca.pem:/etc/openfga/database-ca.pem:ro" \
  openfga/openfga:v1.22.0 migrate \
  --datastore-engine postgres \
  --datastore-uri "postgres://kindgi:$DB_PASSWORD@10.20.0.3:5432/openfga?sslmode=verify-ca&sslrootcert=/etc/openfga/database-ca.pem"

docker run -d --name kindgi-openfga --network kindgi --restart unless-stopped \
  -v "$PWD/database-ca.pem:/etc/openfga/database-ca.pem:ro" \
  openfga/openfga:v1.22.0 run \
  --datastore-engine postgres \
  --datastore-uri "postgres://kindgi:$DB_PASSWORD@10.20.0.3:5432/openfga?sslmode=verify-ca&sslrootcert=/etc/openfga/database-ca.pem" \
  --playground-enabled=false
```

On Cloud Run, a secret mounted as a volume gives OpenFGA the file
([Google: configure secrets](https://docs.cloud.google.com/run/docs/configuring/services/secrets)).

A CA that didn't sign the server's certificate stops OpenFGA: `migrate`
exits 1, and `run` exits 2 once it has retried its first connection. Both
name the reason:

```text
… failed to write startup message: write failed: x509: certificate signed by unknown authority
```

OpenFGA reads the file when it starts. So when you
[rotate the server's CA](#rotate-the-servers-ca), give OpenFGA the new file
and restart it in step 2, with the runtime, before the rotation.
