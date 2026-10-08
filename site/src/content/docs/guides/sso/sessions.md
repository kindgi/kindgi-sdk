---
title: Sessions
description: How long a console sign-in lasts, signing out, and how sessions differ from API tokens.
sidebar:
  order: 2
---

Signing in to the console starts a **session**: a cookie the browser sends
with each request, `__Host-kindgi_session`. It's `HttpOnly`, so the page's
own scripts can't read it, and the runtime stores only its hash.

## How long it lasts

- **12 hours** from sign-in (`KINDGI_SESSION_TTL_MS`);
- **an hour without use** ends it sooner (`KINDGI_SESSION_IDLE_TIMEOUT_MS`);
- a session that started from an API token also ends with that token, if
  sooner.

Then you sign in again. A session in the browser isn't refreshed: a refresh
is refused with `400 cookie-session-not-refreshable`, "A browser session
(cookie) is not refreshed: sign in again when it ends".

## Signing out

Signing out ends the session at once, on the runtime too: a request with it
afterwards gets `401 auth-revoked`. Removing a person ends their sessions,
and they can't sign in again.

## Requests from other sites

A request signed in by the session cookie that changes something (any
method but `GET`, `HEAD` and `OPTIONS`) must say where it comes from, in its
`Origin` header, and come from the console's own address. One without an
`Origin`, or from anywhere else, is refused with `403 csrf-origin-mismatch`,
so another site can't act through your session.

## Sessions and API tokens

API tokens are for the API, the CLI and the SDKs, and they don't expire with
a session. The console's session is only for the console.
