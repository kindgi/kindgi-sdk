---
title: A small dev instance on Cloud Run
description: Run a small Kindgi beside an app on Cloud Run — no VPC, the pack service asleep when idle, and a small or shared Cloud SQL instance — with the same Terraform module.
sidebar:
  order: 2.1
---

For a dev environment beside an app, in the app's own Google Cloud project, you run the
same Terraform module as [Deploy on Google Cloud Run](../cloud-run/) with a
few settings changed: no VPC, the pack service asleep when idle, and either a
small Cloud SQL instance of Kindgi's own or the app's existing one.
`example-dev.tfvars` in the module is the starting point.

This shape trades the default's isolation — its own VPC, static egress, and
database — for a smaller, cheaper footprint. **It is not for production.**

The steps are the Cloud Run guide's. This page is only what changes: the
network, the database, and the pack service. Read it alongside
[Deploy on Google Cloud Run](../cloud-run/), and copy `example-dev.tfvars`
instead of `example.tfvars` at [the foundation step](../cloud-run/#1-the-foundation).

## No VPC

Set `network_mode = "none"` **and** `pack_ingress = "INGRESS_TRAFFIC_ALL"`.
The module creates no VPC, subnet, Cloud NAT or connector; both services reach
the internet through Cloud Run's own egress. Without a VPC the runtime reaches
the pack service over its public URL, so the plan refuses `none` unless you
open the pack's ingress — it is not set for you. The pack stays closed by IAM
to the runtime's service account, which still calls it with a Google ID token
on every call, so the public URL stays shut to everyone else.

Two things follow:

- **There is no static egress IP.** The pack's tools reach only public
  addresses and the instances in `pack_cloud_sql_instances`. With `none` the
  module refuses `nat_static_ip` — there is no Cloud NAT to pin an address to.
  If your tools need a fixed outbound address or a private VPC, use the
  `direct` or `connector` shape instead
  ([A new VPC, or yours](../cloud-run-reference/#a-new-vpc-or-yours)).
- **The database must have a public IP.** With `none` the module refuses
  `database_private_network`, so a private-IP Cloud SQL instance is out. An
  organization policy that forbids public IPs on Cloud SQL
  (`sql.restrictPublicIp`) rules this shape out — use `direct` or `connector`
  with `database_private_network` instead.

If your organization forbids public access to Cloud Run
(`iam.allowedPolicyMemberDomains` refuses `allUsers`), set
`server_invoker_iam_disabled = true` with `server_public = false`, as
`example-dev.tfvars` does. The runtime's API token still guards every call.

## The database

Pick one of two, **at the first apply** — moving between them later is a dump
and restore, not an in-place change.

### A small instance of Kindgi's own

Remove `database_host_instance` from your copy of `example-dev.tfvars` — it
sets that for the shared-instance path below — and set `database_tier` to a
shared-core tier, such as `db-g1-small`. The module makes the instance (about
six minutes on the first apply). You do not need to touch `database_edition`:
its default, `ENTERPRISE`, is the [Cloud SQL edition](https://docs.cloud.google.com/sql/docs/postgres/editions-intro)
that runs a shared-core tier. A Postgres 16 instance otherwise defaults to
`ENTERPRISE_PLUS`, which takes only `db-perf-optimized-N-*` tiers and would
reject `db-g1-small`.

### The app's existing instance

Set `database_host_instance` to the name of the app's Cloud SQL instance **in
this same Google Cloud project** — the module looks it up there, makes no
instance of its own, and creates Kindgi's `database_name` database on it.
(`database_tier` and `database_edition` are ignored in this case; the host
instance's own tier and edition apply.)

You still create Kindgi's user at [the secrets step](../cloud-run/#3-the-secrets),
with one line changed: the Cloud SQL Admin API's users URL must name the host
instance, so use it in place of `$N` — `instances/<host-instance>/users` rather
than `instances/$N/users`. Nothing else at that step changes: `CONN` (from
`terraform output -raw sql_connection_name`) already resolves to the host
instance, so the connection string is right, and the `$N-database-url` secret
keeps your `name_prefix`.

- The instance must have a public IP and run **Postgres 16 or later**. Before
  16, a `CREATEROLE` user — which Kindgi's needs — could grant itself any
  other role, so the two databases wouldn't be walled off.
- Run **one Kindgi deployment per host instance**: Kindgi's role and `PUBLIC`
  connect are instance-wide.
- Kindgi shares the instance's CPU, memory, connections and backups with the
  app, and the instance's admins can reset Kindgi's database password. Only
  the secrets you store through Kindgi's API stay sealed under its own key.
- Backups, point-in-time recovery and deletion protection are the app
  instance's, not Kindgi's. `database_deletion_protection` only keeps Kindgi's
  database object from a Terraform-side drop.

## The pack service sleeps to zero

`pack_min_instances = 0` lets the pack service sleep when idle. The first tool
call after idle waits for it to start — up to about two minutes, its startup
probe. The runtime allows `pack_call_timeout_ms` for a single tool call (120 s
by default, `KINDGI_PACK_CALL_TIMEOUT_MS`); raise it if cold starts run near
that.

The runtime itself stays on: `server_min_instances` keeps its default of 1. A
run started without waiting, an Improve pass or an eval run keeps going after
its response returns, and needs an instance — and the CPU on it — to finish.

## Next

- [Deploy on Google Cloud Run](../cloud-run/) — the full steps this page
  builds on.
- [Cloud Run module reference](../cloud-run-reference/) — every setting, what
  the module grants, and its limits.
- [Operate a self-hosted runtime](../operate/).
