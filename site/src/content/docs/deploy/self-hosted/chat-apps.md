---
title: Let people use Kindgi from Claude
description: Turn on the runtime's MCP endpoint so people can add Kindgi to claude.ai as a custom connector, sign in as themselves, and run their agents from a chat. Open only the paths Claude's servers call.
sidebar:
  order: 3.65
---

People can use Kindgi from their Claude chats: see the agents they may run,
start them, follow a run to its end, set up their own schedules, and see
what's waiting for them. Each person adds your runtime to claude.ai as a
custom connector and signs in to Kindgi. Claude then acts as that person,
with that person's permissions and less: it can't change agents, settings or
other people's work. [Use Kindgi from Claude](../../../guides/chat/) is the
person's side. This needs runtime 0.6.0 or later.

## Before you start

- **A public HTTPS address.** Claude's servers call your runtime, not the
  person's browser, so they have to reach it from the internet. A runtime
  with no public address can't be added to claude.ai.
- **Sign-in for people.** Connecting signs the person in to Kindgi in their
  browser, with your single sign-on or the email link
  ([Turn on sign-in](../sign-in/)). A site's people
  ([WordPress sites](../../../sites/wordpress/)) can't connect: the consent
  page tells them their access is managed by the site.
- **The runtime's settings:** `kindgi.env` for
  [Self-host Kindgi](../self-host/), or the module's `server_env` on
  [Cloud Run](../cloud-run/).

<!-- To confirm: whether the runtime must reach claude.ai's client metadata document (https://claude.ai/oauth/mcp-oauth-client-metadata) on the way out. If so, it's a fourth bullet here. -->

## Turn it on

Add the switch to the runtime's settings, with the address people reach it
at if it isn't set already:

```sh
KINDGI_MCP_SERVER=on
KINDGI_PUBLIC_URL=https://kindgi.example.com
```

<!-- To confirm: KINDGI_MCP_SERVER's final name and values, then a link to its entry in the environment variables reference; which setting the console links in chat answers are built from; and the start output line below, word for word. -->

Restart the runtime. Its start output says the endpoint is on:

```text
  MCP: on at /mcp (sign-in for chat apps: on)
```

On a runtime without an [authorization store](../../authorization/), the
line adds `(no per-project permissions)`. Anyone signed in can then see and
run every agent, and Claude gets the same access.

<!-- To confirm: whether the consent page tells each person so before they allow it. -->


Only agents their builders offer in chat show up there, and each person
gets a tool only for those of them they may run in Kindgi.

<!-- To confirm: the page that tells builders how to offer an agent in chat, to link from the paragraph above. -->

## Give people the address

The address people add in claude.ai is your runtime's public address with
`/mcp` after it:

```text
https://kindgi.example.com/mcp
```

Send it with a link to [Use Kindgi from Claude](../../../guides/chat/).

## Choose what chat answers carry

**Results in chat**, in the console's workspace settings, is on by default.
Turn it off to send only status and links to chat apps, never answers or
files. A tenant admin changes it.

<!-- To confirm: where the console shows Results in chat, by its final name. -->

## Behind a proxy or load balancer

Set `KINDGI_TRUSTED_PROXIES`, as
[Behind a load balancer or ingress](../self-host/#behind-a-load-balancer-or-ingress)
explains. On Cloud Run behind an external Application Load Balancer, that's
the module's `trusted_proxies = "2"` ([Operate it](../cloud-run/#operate-it)).
It matters more with chat apps. Unset, every request counts as
coming from your proxy, so people's browsers and Claude's servers all share
one count for each limit the runtime keeps per address:

- **Signing in**, from people's browsers.
- **Claude's token requests:** 100 every 10 seconds per address.
- **Registering an app:** 10 an hour per address. claude.ai doesn't register
  itself; other chat apps can.

## How many people one Claude address serves

Claude's servers call from a few addresses, and every person using Kindgi
from Claude shares them. The token limit allows 100 requests every 10
seconds from one address, and Claude asks for a new token about every 10
minutes for each person who keeps using it. That's about 6,000 people using
Kindgi from Claude at the same moment for each address Claude calls from,
before new connections.

## Behind a firewall

Claude's servers call these paths, from `160.79.104.0/21`:

- `/mcp`
- `/.well-known/oauth-*`
- `/auth/oauth2/token` and `/auth/oauth2/register`
- `/auth/jwks`

Open only these to that range. People's browsers reach the rest of `/auth/`
(signing in and the consent page) and the console from wherever they work, as
they do without chat.

Anthropic can change the range. Check
[Anthropic's page](https://claude.com/docs/connectors/building/authentication.md)
for the current one.

<!-- To confirm: the paths. /.well-known/oauth-* doesn't cover /.well-known/openid-configuration; /auth/oauth2/introspect and /auth/oauth2/revoke stay closed. -->

**With nginx** in front, one `location` per path, each admitting only
Claude's range:

```nginx
location = /mcp {
    allow 160.79.104.0/21;
    deny all;
    proxy_pass http://kindgi;
}
location ^~ /.well-known/oauth- {
    allow 160.79.104.0/21;
    deny all;
    proxy_pass http://kindgi;
}
location ~ ^/auth/oauth2/(token|register)$ {
    allow 160.79.104.0/21;
    deny all;
    proxy_pass http://kindgi;
}
location = /auth/jwks {
    allow 160.79.104.0/21;
    deny all;
    proxy_pass http://kindgi;
}
```

Admit everything else only from your own network, for example:

```nginx
location / {
    allow 10.0.0.0/8;
    deny all;
    proxy_pass http://kindgi;
}
```

`kindgi` is the `upstream` that points at your runtime. Keep the
`proxy_set_header` lines your other locations use, so the runtime gets the
client's address.

**With Cloud Armor**, one rule that admits Claude's range on those paths,
with a lower number than any rule that would deny them, so it's checked
first:

```sh
gcloud compute security-policies rules create 900 \
  --security-policy=kindgi-front \
  --action=allow \
  --expression="inIpRange(origin.ip, '160.79.104.0/21') && (request.path.startsWith('/.well-known/oauth-') || request.path.matches('^/(mcp|auth/jwks|auth/oauth2/(token|register))$'))"
```

`kindgi-front` is your policy's name. Keep the rules that admit your own
people to the console and `/auth/`, and leave the default rule denying
everything else.

Cloud Armor sees only requests that come through your load balancer. A
Cloud Run service also answers at its own `run.app` address, so limit the
runtime's ingress to internal and Cloud Load Balancing
([Cloud Run: Restrict network endpoint ingress](https://docs.cloud.google.com/run/docs/securing/ingress)),
or these paths stay open to everyone there.

<!-- To confirm: the Cloud Run module sets the server's ingress to all and has no setting for it, so a change made outside the module goes back on its next apply. Name the module's setting here once it has one. -->
