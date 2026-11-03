---
title: Sessions
description: How long a console sign-in lasts, signing out, and how sessions differ from API tokens.
sidebar:
  order: 2
---

This page explains how long a console sign-in lasts, how it ends, and how it
differs from an API token.

Signing in to the console starts a **session**: a cookie the browser sends
with each request, `__Host-kindgi_session`. It's `HttpOnly`, so the page's
own scripts can't read it. The runtime stores only its hash. Signing in also
uses two short-lived cookies:

- `__Host-kindgi_pick`, while you choose a workspace;
- `__Host-kindgi_link_asked`, for a day after you ask for a sign-in link.

## How long it lasts

- **12 hours** from sign-in (`KINDGI_SESSION_TTL_MS`);
- **an hour without use** ends it sooner (`KINDGI_SESSION_IDLE_TIMEOUT_MS`);
- a session that started from an API token also ends with that token, if
  sooner.

Then you sign in again. A session in the browser isn't refreshed: a refresh
is refused with `400 cookie-session-not-refreshable`, "A browser session
(cookie) is not refreshed: sign in again when it ends".

## Signing out

Signing out asks first, then ends the session at once, on the runtime too: a
request with it afterwards gets `401 auth-revoked`.

Sessions also end when what they came from goes:

- **An admin signs a person out everywhere**
  (`POST /v1/identity/users/<id>/revoke-sessions`), or removes them. A
  removed person can't sign in again either.
- **Revoking an API key** ends the console sessions that key opened. Each
  request on one checks the key, so once it's revoked, the next request is
  refused with `401 auth-revoked`, "The API key this session was opened
  with is revoked: sign in again". Changing the runtime's own token
  (`KINDGI_API_TOKEN`) ends the sessions the old token opened.
- **Removing an identity provider,** or changing which one is behind it,
  ends the sessions people opened through it
  ([Set up SSO](../#change-it-list-it-remove-it)).

## Requests from other sites

A request that changes something uses any method but `GET`, `HEAD` and
`OPTIONS`. When the session cookie signs it in, it must say where it comes
from, in its `Origin` header, and come from the console's own address. One
without an `Origin`, or from anywhere else, is refused with
`403 csrf-origin-mismatch`, so another site can't act through your session.
A runtime without `KINDGI_PUBLIC_URL` accepts such a request only from an
`https` origin, or `http` on `localhost`.

Under `kindgi dev`, the console works at `localhost`, `127.0.0.1` or `[::1]`
on the runtime's port. A browser takes each of these for a different
address. Anywhere else is refused, and the refusal names the address to open
the console at. Here, from another port:

```json
{"error":{"code":"csrf-origin-mismatch","message":"A request signed in by the session cookie can't come from http://localhost:18097; open the console at http://localhost:18096","requestId":"…"}}
```

## Sessions and API tokens

API tokens are for the API, the CLI and the SDKs, and they don't expire with
a session. The console's session is only for the console.
