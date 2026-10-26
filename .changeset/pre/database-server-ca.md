---
"@kindgi/env-schema": patch
---

**Two server settings that have the runtime check its database server's certificate against a CA you give** (runtime 0.2.0 on):
- **`KINDGI_DATABASE_SERVER_CA_PATH`:** a PEM file of the CA certificates the database server's certificate must chain to. Set, every connection uses TLS whatever the URL's `sslmode` says, and the certificate must chain to one of these CAs and be in date. Its name is checked too only with `sslmode=verify-full`. For a database reached by an address its certificate doesn't name, such as Cloud SQL by private IP with its per-instance CA.
- **`KINDGI_DATABASE_SERVER_CA`:** the same certificates inline, for platforms that give settings as environment variables. One or the other, not both.
