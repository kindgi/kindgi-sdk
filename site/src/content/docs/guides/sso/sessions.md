---
title: Sessions
description: How long a console sign-in lasts, signing out, and how sessions differ from API tokens.
sidebar:
  order: 2
---

Signing in to the console starts a **session**: a cookie the browser sends
with each request, `__Host-kindgi_session`. It's `HttpOnly`, so the page's
own scripts can't read it, and the runtime stores only its hash. Signing in
also uses two short-lived cookies: `__Host-kindgi_pick`, while you choose a
workspace, and `__Host-kindgi_link_asked`, for a day after you ask for a
sign-in link.

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
  (`POST /v1/identity/users/<id>/revoke-sessions`), or removes them, who then
  can't sign in again either.
- **Revoking an API key** ends the console sessions that key opened, and
  changing the runtime's own token (`KINDGI_API_TOKEN`) ends the ones the
  old token opened.
- **Removing an identity provider,** or changing which one is behind it,
  ends the sessions people opened through it
  ([Set up SSO](../#change-it-list-it-remove-it)).

## Requests from other sites

A request signed in by the session cookie that changes something (any
method but `GET`, `HEAD` and `OPTIONS`) must say where it comes from, in its
`Origin` header, and come from the console's own address. One without an
`Origin`, or from anywhere else, is refused with `403 csrf-origin-mismatch`,
so another site can't act through your session. A runtime without
`KINDGI_PUBLIC_URL` accepts such a request only from an `https` origin, or
`http` on `localhost`.

## Sessions and API tokens

API tokens are for the API, the CLI and the SDKs, and they don't expire with
a session. The console's session is only for the console.
