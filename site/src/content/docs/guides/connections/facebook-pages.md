---
title: Facebook Pages
description: Connect your company's Facebook Page through Kindgi's own Meta app, so tools can post on it as the Page.
sidebar:
  order: 26
  label: Facebook Pages
---

When you finish this page, your workspace has its Facebook Page connected.
A tool that asks for `posts.write` can then post on the Page as the Page,
after a person approves it. You connect through Kindgi's own Meta app, so
there's no app to create at Meta, and none to register in your workspace.

A Facebook Page connection is the company's. An admin makes it, and runs
use it as the company's connection
([Choose a connection](../choose-a-connection/)).

## Before you start

- **You're an admin of the workspace.**
- **The Page is in a Meta business portfolio you manage.** When you
  connect, Meta asks you to pick the portfolio and the Pages to share with
  Kindgi.
- **On a self-hosted runtime, a Kindgi account key** (`KINDGI_ACCOUNT_KEY`),
  kept in the runtime's secret store. Meta's sign-in goes through Kindgi's
  connect step, and the key is how the step knows your runtime: it pins
  your runtime's public address and your company's name. Without the key,
  Facebook Pages shows **Needs a Kindgi account**, and nothing else
  changes. On Kindgi Cloud there's nothing to set.

## Connect

In a project, open **Connections**, choose **Connect an app**, pick
Facebook Pages, and under **For** choose **The company**:

1. **Kindgi's connect page** names your company and the Kindgi address that
   asked. Choose **Continue** only if you started this from your own Kindgi
   console. A link someone sent you to Meta's page does nothing without
   this step.
2. **At Meta,** pick the business portfolio and the Pages to share with
   Kindgi, and allow what's asked: posting on the Page as the Page,
   editing or deleting its posts, and seeing its name and posts.
3. **Back in Kindgi,** the connection shows the Page's name. If you shared
   several Pages, Kindgi asks which one this connection is for.

Connect once for each Page your tools post on.

## Disconnecting

**Connections → Disconnect** destroys the stored token in your secret store
([How connections work](../reference/#disconnecting)). Kindgi withdraws
nothing at Meta.

An admin of the business portfolio can also remove Kindgi at Meta, in the
business's **Business Integrations**
([Meta: Facebook Login for Business](https://developers.facebook.com/docs/facebook-login/facebook-login-for-business)).

## When Meta ends access

If Meta stops taking the token, Kindgi isn't told: it finds out when Meta
refuses a call. That call fails, the connection needs reconnecting, and the
**Connections** page shows it. An admin connects it again.

## Limits

Meta counts the calls for each Page, not across every company on Kindgi's
app, and refuses calls over its limits
([Meta: Rate limits](https://developers.facebook.com/docs/graph-api/overview/rate-limiting)).
Kindgi passes Meta's refusal on as it is.
