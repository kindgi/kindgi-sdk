---
title: LinkedIn
description: Register your company's own LinkedIn app with Kindgi, so people can connect their LinkedIn profile and tools can post as them.
sidebar:
  order: 25
  label: LinkedIn
---

When you finish this page, people in your workspace can connect their own
LinkedIn profile. A tool, such as the ready-made
[`linkedinPost`](../use-a-connection/#ready-made-tools), can then post on
LinkedIn as them, after they approve it. They connect through a LinkedIn
app your company creates, which you register with Kindgi once.

The app uses two LinkedIn products anyone can add, with no review by
LinkedIn. Posting as your company's LinkedIn Page takes a product LinkedIn
reviews first, and isn't covered here.

## Before you start

- **You're an admin of the workspace.**
- **The runtime's public address is set** (`KINDGI_PUBLIC_URL`), and people
  reach the console there. This page writes it as `https://kindgi.acme.com`.
- **Your company's LinkedIn Page,** and a super admin of it. LinkedIn ties
  each app to a Page, and that Page's super admin verifies the app.
- **The `kindgi` CLI reaches your runtime as you,** with the runtime's address
  exported as `KINDGI_API_URL` and your API key as `KINDGI_API_TOKEN`
  ([People and keys](../../../deploy/people-and-keys/#api-keys)). Kindgi
  0.2's CLI runs from any folder as `npx --yes @kindgi/cli@0.2`
  ([Install](../../../start/install/)).

## 1. Create the app at LinkedIn

In the [LinkedIn Developer Portal](https://www.linkedin.com/developers/apps):

1. **Create app.** Give it a name people recognize when they connect, your
   company's LinkedIn Page, your privacy policy's URL and a logo, which
   people see when they connect
   ([LinkedIn: Create an app](https://www.linkedin.com/help/learning/answer/a1667239)).
   The app stays tied to that Page for good: LinkedIn can't move it to
   another.
2. **Settings → Verify → Generate URL.** Copy the URL and send it to the
   Page's super admin, who opens it and verifies the app within 30 days
   ([LinkedIn: Verify an app](https://www.linkedin.com/help/learning/answer/a1665329)).
3. **Products:** make sure the app has **Share on LinkedIn** and **Sign In
   with LinkedIn using OpenID Connect**, and request either one it doesn't.
   Both are self-service, with no review
   ([LinkedIn: Getting access](https://learn.microsoft.com/en-us/linkedin/shared/authentication/getting-access)).
   The first lets the app post as the people who connect
   (`w_member_social`), and the second lets Kindgi learn whose profile it is
   and its email address (`openid` and `email`).
4. **Auth → OAuth 2.0 settings,** add the console's connect page as a
   redirect URL:

   ```text
   https://kindgi.acme.com/console/connect/callback
   ```

   LinkedIn refuses a sign-in that returns anywhere not listed here. The URL
   is absolute and `https`, with no `#`
   ([LinkedIn: Authorization Code Flow](https://learn.microsoft.com/en-us/linkedin/shared/authentication/authorization-code-flow)).
5. **Keep the Client ID and the Primary Client Secret** from the **Auth**
   tab's **Application credentials**.

Use this app only for Kindgi. LinkedIn ends a person's earlier access when
they allow the same app a different set of permissions
([When LinkedIn ends access](#when-linkedin-ends-access)), so a sign-in with
LinkedIn on your website through the same app would end their Kindgi
connection.

## 2. Store the client secret

The secret goes into Kindgi's secret store under a name, never into a
registration or a chat:

```sh
npx --yes @kindgi/cli@0.2 secrets set ACME_LINKEDIN_CONNECT_SECRET --env=production --scope=tenant
```

- `ACME_LINKEDIN_CONNECT_SECRET` is the secret's name. The registration
  keeps only this name.
- `--env` is the runtime's environment, its `KINDGI_ENV`.
- `--scope=tenant` stores the secret for the whole workspace.

The command asks for the value twice, and doesn't show what you type.

## 3. Register the app with Kindgi

In the console, open your workspace's **App registrations** page, choose
**Register an app**, and pick **LinkedIn** as the **App**:

- **Client id:** the Client ID.
- **Client secret: its name in Kindgi's secrets:** the environment and name
  you stored it under, `production/ACME_LINKEDIN_CONNECT_SECRET`.
- **Which projects' runs may use it:** leave it empty for all of them.

Then choose **Register**. Kindgi shows the **Redirect URI** you entered in
step 1.

## 4. Connect

Each person connects their own profile. In a project, open
**Connections**, choose **Connect an app**, pick LinkedIn, sign in to
LinkedIn, and allow what's asked.

The connection shows your LinkedIn account's email address, what it allows,
and when it was last used.

**Reconnect every 60 days.** LinkedIn's access lasts 60 days, and LinkedIn
renews it only for partners it approves
([LinkedIn: Authorization Code Flow](https://learn.microsoft.com/en-us/linkedin/shared/authentication/authorization-code-flow)).
So when the 60 days end, the connection needs reconnecting: connect again
from **Connections**, or from a run that's waiting for you. If LinkedIn
gives your app refresh tokens, as it does for partners it approves, Kindgi
renews the access as it does for other apps.

If you turn it down on LinkedIn's page, the connect is declined. If a
tool's call asked you to connect, that call fails with
`connection-declined`.

## Disconnecting

**Connections → Disconnect** destroys the stored token in your secret store
([How connections work](../reference/#disconnecting)). Kindgi withdraws
nothing at LinkedIn, which documents no way for an app to give a token
back. The token works until its 60 days end, or until the person removes
your app.

To remove it, the person opens LinkedIn's **Settings & Privacy**, then
**Data privacy**, chooses **Change** next to **Permitted services**, and
removes your app
([LinkedIn: Remove a permitted service](https://www.linkedin.com/help/linkedin/answer/a519947)).

## When LinkedIn ends access

- **After 60 days,** unless LinkedIn gives your app refresh tokens. Kindgi
  knows when, so the connection needs reconnecting just before then, with
  no call to LinkedIn.
- **The person removes your app** at LinkedIn.
- **The person allows your app a different set of permissions,** through
  Kindgi or anywhere else, and LinkedIn ends the access it gave before
  ([LinkedIn: Authorization Code Flow](https://learn.microsoft.com/en-us/linkedin/shared/authentication/authorization-code-flow)).

LinkedIn sends Kindgi no notice of the last two, so Kindgi finds out when
LinkedIn refuses a call. Either way, a run its owner started waits for them
to connect again. In any other run, the call fails with
`connection-missing`, and the **Connections** page shows it.

## Changing the client secret

To change the client secret, for example when someone who knew it leaves:

1. **At LinkedIn,** on the app's **Auth** tab, choose **Generate a New
   Client Secret** and confirm. The old one becomes the **Secondary Client
   Secret**, and both work
   ([LinkedIn: Secure your application](https://learn.microsoft.com/en-us/linkedin/shared/api-guide/best-practices/secure-applications)).
2. **Store the new one as a new version** under the same name:

   ```sh
   npx --yes @kindgi/cli@0.2 secrets set ACME_LINKEDIN_CONNECT_SECRET --env=production --scope=tenant --write-mode=add-version
   ```

   Connections keep working: Kindgi uses the new secret from the next
   connect.
3. **Remove the Secondary Client Secret** on the **Auth** tab.

## Limits

Kindgi paces each connection's calls at LinkedIn's limit for one member:

- **150 calls a day,** LinkedIn's limit for each member
  ([LinkedIn: Share on LinkedIn](https://learn.microsoft.com/en-us/linkedin/consumer/integrations/self-serve/share-on-linkedin)).
  After 150, the next call waits until the allowance refills, about 10
  minutes for each call.

A call through [`appFetch`](../use-a-connection/#read-the-token) takes 1
unit, so your own tool's calls to LinkedIn count too.

LinkedIn also limits your app to 100,000 calls a day across all its
members, and refuses calls over that until its limits reset at midnight
UTC
([LinkedIn: Rate limits](https://learn.microsoft.com/en-us/linkedin/shared/api-guide/concepts/rate-limits)).
Kindgi doesn't pace that one.
