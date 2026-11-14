---
title: Let people use Kindgi from Claude
description: Turn on the runtime's MCP endpoint so people can add Kindgi to claude.ai as a custom connector, sign in as themselves, and run their agents from a chat. Open only the paths Claude's servers call.
sidebar:
  order: 3.65
---

People can use Kindgi from their Claude chats: run the agents and flows
offered in chat, and follow each run to its end. Each person adds your
runtime to claude.ai as a custom connector and signs in to Kindgi. Claude
then acts as that person, with that person's permissions and less: it can't
change agents, settings or other people's work.
[Use Kindgi from Claude](../../../guides/chat/) is the person's side. This
needs runtime 0.6.0 or later.

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
- **A way out to claude.ai.** claude.ai names itself with a client metadata
  document
  ([Authentication for connectors](https://claude.com/docs/connectors/building/authentication)),
  so the runtime fetches
  `https://claude.ai/oauth/mcp-oauth-client-metadata` when someone connects.
  If your runtime's outbound traffic is limited, allow that address.

## Turn it on

Add the switch to the runtime's settings, with the address people reach it
at if it isn't set already:

```sh
KINDGI_MCP_SERVER=on
KINDGI_PUBLIC_URL=https://kindgi.example.com
```

`KINDGI_MCP_SERVER` is `off` unless you set it, and `/mcp` then answers 404
([the variable](../../../reference/env-vars/#kindgi_mcp_server)). With it
`on`, the runtime doesn't start unless sign-in is set up and
`KINDGI_PUBLIC_URL` is set. That address can't have a path, as in
`https://example.com/kindgi`, because a chat app looks for sign-in at its
root. The runtime doesn't need an authorization store for chat apps.

Restart the runtime. Its start output says the endpoint is on:

```text
  MCP: on at /mcp (sign-in for chat apps: on)
```

On a runtime without an [authorization store](../../authorization/), the
line adds `(no per-project permissions)`. Anyone signed in can then see and
run every agent, and Claude gets the same access.

Only agents and flows their builders offer in chat show up there
([an agent's](../../../guides/agents/write-an-agent/#offer-it-in-a-chat-app)
and [a flow's](../../../guides/flows/write-a-flow/#offer-it-in-a-chat-app)
`mcp`). Each person gets a tool for each of those they can see in Kindgi,
and running one still takes their permission to run it.

## Give people the address

The address people add in claude.ai is your runtime's public address with
`/mcp` after it:

```text
https://kindgi.example.com/mcp
```

Send it with a link to [Use Kindgi from Claude](../../../guides/chat/).

Chat answers link to runs and waits in the console at your public address
with `/console` after it, when the runtime serves the console itself. When
your console runs elsewhere, chat answers carry no console links.

A person's sign-in history (their page under **People**, and
`GET /v1/audit/sign-ins?userId=`) also lists each chat app they connected,
each refused renewal of one, and each disconnect (runtime 0.7.0 or later).
In the API, `reason` says why a renewal was refused.

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
  itself; other chat apps can. A desktop app can register without saying what
  kind of app it is when it sends people back to its own scheme, or over
  `http` to `localhost`, `127.0.0.1` or `[::1]` (this needs runtime 0.7.0 or
  later).

## How many people one Claude address serves

Claude's servers call from a few addresses, and every person using Kindgi
from Claude shares them. The token limit allows 100 requests every 10
seconds from one address, and Claude asks for a new token about every 10
minutes for each person who keeps using it. That's about 6,000 people using
Kindgi from Claude at the same moment for each address Claude calls from,
before new connections.

## Behind a firewall

Claude's servers call these paths from Anthropic's outbound addresses,
listed on
[Anthropic's IP addresses page](https://platform.claude.com/docs/en/api/ip-addresses):

- `/mcp`
- `/.well-known/oauth-protected-resource`,
  `/.well-known/oauth-protected-resource/mcp` and
  `/.well-known/oauth-authorization-server/auth`
- `/auth/oauth2/token` and `/auth/oauth2/register`
- `/auth/jwks`

Open only these to those addresses. That admits Claude only: a desktop chat
app calls the same paths from people's own machines. People's browsers reach
the rest of `/auth/` (signing in and the consent page) and the console from
wherever they work, as they do without chat.

The examples below use `160.79.104.0/21`. Anthropic can change its
addresses, so take the current ones from that page.

**With nginx** in front, one `location` per path, each admitting only
Claude's range:

```nginx excerpt
location = /mcp {
    allow 160.79.104.0/21;
    deny all;
    proxy_pass http://kindgi;
}
location ~ ^/\.well-known/oauth-(protected-resource(/mcp)?|authorization-server/auth)$ {
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

```nginx excerpt
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
  --expression="inIpRange(origin.ip, '160.79.104.0/21') && request.path.matches('^/(mcp|auth/jwks|auth/oauth2/(token|register)|[.]well-known/oauth-(protected-resource(/mcp)?|authorization-server/auth))$')"
```

`kindgi-front` is your policy's name. Keep the rules that admit your own
people to the console and `/auth/`, and leave the default rule denying
everything else.

Cloud Armor sees only requests that come through your load balancer. A
Cloud Run service also answers at its own `run.app` address, so limit the
runtime's ingress to internal and Cloud Load Balancing
([Cloud Run: Restrict network endpoint ingress](https://docs.cloud.google.com/run/docs/securing/ingress)),
or these paths stay open to everyone there. With the
[Cloud Run](../cloud-run/) module, set it in the module, not by hand: its
next apply puts back a change made outside it.

```hcl excerpt
server_ingress = "INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER"
```

It needs `network_mode = "direct"`, and `public_url` set to the load
balancer's address.
