---
title: Instagram
description: Connect your company's Instagram professional account through Kindgi's own Meta app, so tools can post photos to it.
sidebar:
  order: 27
  label: Instagram
---

When you finish this page, your workspace has its Instagram account
connected. A tool that asks for `posts.write` can then post photos to the
account, after a person approves it. You connect through Kindgi's own Meta
app, so there's no app to create at Meta and nothing to register with
Kindgi.

An Instagram connection is the company's. An admin makes it, and runs use
it as the company's connection
([Choose a connection](../choose-a-connection/)). Its token reaches the
Instagram accounts you share and nothing else: it can't post on the
business's Facebook Pages, which have [their own connection](../facebook-pages/).

## Before you start

- **You're an admin of the workspace.**
- **The account is an Instagram professional account,** a business or
  creator account, in a Meta business portfolio you manage. When you
  connect, Meta asks you to pick the portfolio and the accounts to share
  with Kindgi.
- **On a self-hosted runtime, a Kindgi account key** (`KINDGI_ACCOUNT_KEY`),
  kept in the runtime's secret store. Meta's sign-in goes through Kindgi's
  connect step, and the key is how the step knows your runtime: it pins
  your runtime's public address and your company's name. Without the key,
  Instagram shows **Needs a Kindgi account**, and nothing else changes. On
  Kindgi Cloud there's nothing to set.

## Connect

In a project, open **Connections**, choose **Connect an app**, pick
Instagram, and under **For** choose **The company**:

1. **Kindgi's connect page** names your company and the Kindgi address that
   asked. Choose **Continue** only if you started this from your own Kindgi
   console. A link someone sent you to Meta's page does nothing without
   this step.
2. **At Meta,** pick the business portfolio and the Instagram accounts to
   share with Kindgi, and allow what's asked: posting photos to the
   account, and seeing its name and profile.
3. **Back in Kindgi,** the connection shows the account's `@username`. If
   you shared several accounts, Kindgi asks which one this connection is
   for.

Connect once for each account your tools post to.

## Disconnecting

**Connections → Disconnect** destroys the stored token in your secret store
([How connections work](../reference/#disconnecting)). Kindgi withdraws
nothing at Meta.

To remove Kindgi's access at Meta as well, an admin of the business
portfolio removes Kindgi from the business's **Business Integrations**
([Meta: Facebook Login for Business](https://developers.facebook.com/docs/facebook-login/facebook-login-for-business)).

## When Meta ends access

Meta's token for a business doesn't expire, so there's nothing to renew.
If Meta stops taking it, for example when the business removes Kindgi at
Meta, Meta sends Kindgi no notice: Kindgi finds out when Meta refuses a
call. That call fails, the connection needs reconnecting, and the
**Connections** page shows it. An admin connects it again.

## Limits

Meta limits how many posts an account publishes through apps in 24 hours,
and refuses more
([Meta: Content publishing](https://developers.facebook.com/docs/instagram-platform/content-publishing)).
Kindgi passes Meta's refusal on as it is.
