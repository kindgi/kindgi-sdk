---
title: What the runtime sends to Kindgi
description: The one call a Kindgi runtime makes to Kindgi on its own, a daily report that renews its license key. What it sends, when, what Kindgi keeps, and how a key that doesn't report works.
sidebar:
  order: 3.25
---

A Kindgi runtime you run yourself, 0.7.0 or later, makes one call to Kindgi
on its own: a short report to access.kindgi.com once a day. The answer
renews its license key. The runtime checks its key offline, and nothing
else goes to Kindgi.

## When it reports

Each server picks a random id at its first start (or takes it from
`KINDGI_SERVER_ID`) and keeps it in its database, with the time of its last
report. In development, `kindgi dev`
gives every project on your laptop the laptop's one id and one license
folder ([below](#what-comes-back)), so the laptop reports once a day,
whatever its projects' databases.

- The first report goes no sooner than an hour after the server first
  starts (when its id is an hour old), then one a day. The server checks at
  start and every hour.
- Replicas of one deployment share its database, so one of them reports.
- Most CI runs and tests start on a fresh database, with a new server id,
  and run for less than an hour, so they send none. A CI job that
  runs `kindgi dev` has a fresh home folder, so the same holds. A CI job that
  keeps its database or its home folder, or runs for longer, does report,
  once a day.
- A key that doesn't report never reports ([below](#a-key-that-doesnt-report)).
- Reporting needs runtime 0.7.0 or later: an older runtime never reports.
- A server that [serves many tenants](../serve-many-tenants/) reports like
  any other.
- Kindgi Cloud's runtime doesn't send one: its key is one that doesn't
  report, and its use is counted under Kindgi Cloud.

## What it sends

One `POST` to `https://access.kindgi.com/v1/report`, over HTTPS:

- **your license key,** as the request's bearer token, to show the report is
  yours. The key names who it's for. access.kindgi.com doesn't store or log
  it;
- **the server id,** which is random and names nothing;
- **the mode:** `dev` or `deployed`;
- **counts of the server's use** since its current key was issued, with the
  runtime's version: the runs started, how many people started runs or
  decided approvals, and the projects in production. They're the counts
  [`kindgi license renew --runtime`](../renew-the-license-key/#what-renewing-sends)
  sends, and they're counts only: no content and no names. In development,
  each day's counts are those of the project that sent that day's report.

Like any request, it shows Kindgi the server's IP address.

## What comes back

- **A non-production key** in its last 30 days gets its next key in the
  answer. The server checks it (signed by Kindgi, for the same holder,
  running later), keeps it in its database, and runs on it from then on,
  without a restart. So a server that reports keeps its own key current.
- **A production key** gets its current term's key, so once Kindgi extends
  your license, the server picks up the next term's key by itself.
- When there's nothing new, the server keeps the key it has.
- When Kindgi won't renew the key (it's been revoked, say), the answer says
  why. The server logs that as a warning and keeps running on its key to its
  date.

The key in your settings still decides who the server runs as. A stored key
is used only when it's for the same holder and runs later. When you change
`KINDGI_LICENSE_KEY` to another holder's key, the server runs on the new
key. A
server started on a fresh database begins on the key in your settings
again.

The database holds the renewed key sealed under a key derived from
`KINDGI_LICENSE_KEY`, so a backup, dump or replica of it alone holds no key
that runs. Keep the secret that holds `KINDGI_LICENSE_KEY` apart from the
database's backups ([Back up and restore](../back-up-and-restore/#back-up-postgres)).
A server whose `KINDGI_LICENSE_KEY` has changed can't open a key sealed
under the old one: it runs on the new key, and its next report keeps one
sealed under that.

`KINDGI_LICENSE_DIR` names a folder where the server also writes each fresh
key, as `license-key`, and its last report's time, as `last-report`. Servers
that share the folder report once a day between them, whatever their
databases. In development, `kindgi dev` sets it to a folder in your home
folder, so every project on the laptop starts with the newest key and the
laptop reports once a day.

## What Kindgi keeps

One record per server: its id, the mode, the runtime version, when it first
and last reported, and its latest counts. Each record is deleted about 400
days after its last report. There's also a line in your access log for each
report. Kindgi's [privacy page](https://www.kindgi.com/privacy) has the
details and the date they start.

## Where it goes, and proxies

- `KINDGI_LICENSE_REPORT_URL` sets where reports go. The default is
  `https://access.kindgi.com/v1/report`, and it takes `https` addresses
  only.
- The report honours `HTTPS_PROXY`, `HTTP_PROXY` and `NO_PROXY`, so it goes
  through a company proxy.
- If your network admits only known hosts, admit `access.kindgi.com` on
  port 443.
- No setting turns reports off. Only a key that doesn't report does.

## What the log shows

Under `license` ([Logs](../logs/)):

- at start, one line:
  `License reports: daily to access.kindgi.com; a renewed key is kept sealed under KINDGI_LICENSE_KEY.`
  (or the host `KINDGI_LICENSE_REPORT_URL` names), or
  `License reports: off: this key is marked offline.`;
- for each report, one line naming what it sent:
  `License report sent: runs 120, people 4, projects in production 2, since 2027-01-04; key renewed to 2027-03-05.`
  When there's no new key, the line ends `key unchanged (to 2027-02-18).`;
- when Kindgi won't renew the key, a warning with access.kindgi.com's
  message;
- when a renewed key is one that doesn't report, one line:
  `License reports: off from now: the renewed key is marked offline.`;
- when a report fails, a warning at the first failure and at the first on
  each later day:
  `License report not sent (<why>); tried again each hour. A server that can't reach Kindgi can ask for a key that doesn't report.`
  where `<why>` is a word naming the cause. The server tries again each
  hour.

The key, the bearer header and your proxy's credentials never appear in the
log.

## If a report can't get through

A failed report never stops the server. The key keeps running to its own
date ([When a key expires](../../../concepts/licensing/#when-a-key-expires)).
A non-production key can be renewed by signing in at
[access.kindgi.com](https://access.kindgi.com). If your servers can't reach
access.kindgi.com at all, ask for a key that doesn't report
([below](#a-key-that-doesnt-report)).

## A key that doesn't report

A key can carry a mark that its server never reports:

- **a production key:** ask with your license, at contact@kindgi.com;
- **a non-production key:** write to contact@kindgi.com, and Kindgi
  decides.

A server with such a key sends nothing to Kindgi, and its start line says
so. A non-production key that doesn't report is renewed by signing in at
access.kindgi.com, or from the deployment with `kindgi license renew`. A
production key that doesn't report is renewed with your contract. Both are
in [Renew the license key](../renew-the-license-key/).
