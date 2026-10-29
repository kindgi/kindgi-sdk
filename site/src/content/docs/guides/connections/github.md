---
title: GitHub
description: Create your company's own GitHub App, register it with Kindgi, and install it on your organization, so tools can work on its repositories.
sidebar:
  order: 20
  label: GitHub
---

When you finish this page, tools in your projects can work on the
repositories you picked through your company's own GitHub App, such as the
[ready-made tools](../use-a-connection/#ready-made-tools) that list issues
and add labels. You create the app by hand on GitHub, register it with
Kindgi once, and install it on your organization.

## Before you start

- **You're an admin of the workspace.**
- **The runtime's public address is set** (`KINDGI_PUBLIC_URL`), and people
  reach the console there. This page writes it as `https://kindgi.acme.com`.
- **You can create GitHub Apps for your organization,** as one of its
  owners or app managers.
- **The `kindgi` CLI reaches your runtime as you,** with the runtime's address
  exported as `KINDGI_API_URL` and your API key as `KINDGI_API_TOKEN`
  ([People and keys](../../../deploy/people-and-keys/#api-keys)). Kindgi
  0.2's CLI runs from any folder as `npx --yes @kindgi/cli@0.2`
  ([Install](../../../start/install/)).

## 1. Create the GitHub App

On GitHub, open your organization's **Settings → Developer settings →
GitHub Apps → New GitHub App**
([GitHub: Registering a GitHub App](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/registering-a-github-app)):

- **GitHub App name** and **Homepage URL:** your choice.
- **Callback URL:** the console's connect page:

  ```text
  https://kindgi.acme.com/console/connect/callback
  ```

- **Request user authorization (OAuth) during installation:** ticked. GitHub
  then sends whoever installs the app back to that page, and Kindgi checks
  the installation is theirs before it keeps it.
- **Webhook:** untick **Active**. You turn it on in step 3, with the
  address Kindgi gives you.
- **Permissions:** what your tools need, such as **Repository → Issues:
  Read and write**. **Metadata: Read-only** comes with every app.
- **Where can this GitHub App be installed? Only on this account.** Only
  your organization can then install it.

Then choose **Create GitHub App**. On the app's page:

- note its **App ID**, its **Client ID**, and its name in the URL
  (`github.com/apps/<slug>`);
- **Generate a new client secret,** and keep it;
- **Generate a private key.** GitHub downloads it as a `.pem` file.

## 2. Store the app's secrets

Make a webhook secret for the app's notices, and keep it for step 3:

```sh
openssl rand -hex 32
```

Three secrets go into Kindgi's secret store under names, never into a
registration or a chat:

```sh
npx --yes @kindgi/cli@0.2 secrets set ACME_GITHUB_CLIENT_SECRET --env=production --scope=tenant
npx --yes @kindgi/cli@0.2 secrets set ACME_GITHUB_WEBHOOK_SECRET --env=production --scope=tenant
npx --yes @kindgi/cli@0.2 secrets set ACME_GITHUB_PRIVATE_KEY --env=production --scope=tenant --from-stdin < acme-kindgi.private-key.pem
```

- Each command but the last asks for the value twice, and doesn't show what
  you type.
- The private key comes from the file GitHub downloaded. Delete the file
  once it's stored.
- `--env` is the runtime's environment, its `KINDGI_ENV`, and
  `--scope=tenant` stores each secret for the whole workspace.

## 3. Register the app

In the console, open your workspace's **App registrations** page, choose
**Register an app**, and pick **GitHub** as the **App**:

- **App id**, **Slug** and **Client id:** from the app's page on GitHub.
- **Client secret**, **Private key** and **Webhook secret:** the
  environment and name you stored each under in Kindgi's secrets:
  `production/ACME_GITHUB_CLIENT_SECRET`,
  `production/ACME_GITHUB_PRIVATE_KEY` and
  `production/ACME_GITHUB_WEBHOOK_SECRET`.
- **Which projects' runs may use it:** leave it empty for all of them.

Then choose **Register**. Kindgi shows what to give GitHub: the
**Callback URL** you entered in step 1, and a **Webhook URL**.

Or register it from the command line:

```sh
npx --yes @kindgi/cli@0.2 connection-apps add github --github-app-id=<github-app-id> --slug=<slug> --client-id=<client-id> --client-secret-ref=production/ACME_GITHUB_CLIENT_SECRET --private-key-ref=production/ACME_GITHUB_PRIVATE_KEY --webhook-secret-ref=production/ACME_GITHUB_WEBHOOK_SECRET
```

`<github-app-id>` is the **App ID** on the app's page on GitHub, a number.
The command prints the registration as JSON: its `redirectUrl` is the
Callback URL, and its `noticesUrl` the Webhook URL.
`--projects=<project-id>,…` lets only those projects' runs use it.

Back on GitHub, in the app's **General** settings, tick
**Webhook → Active**, enter the address Kindgi gave you as the
**Webhook URL** and the webhook secret from step 2 as the **Secret**, and
save. GitHub then sends Kindgi a signed notice when the app is uninstalled
or suspended
([Notices from the app](../reference/#notices-from-the-app)).

## 4. Install it for the company

An admin connects the app for the company. In a project, open
**Connections**, choose **Connect an app**, pick GitHub, and under **For**
choose **The company**. Kindgi shows **Connect GitHub**: choose
**Continue at GitHub**. What GitHub shows depends on whether the app is
installed yet:

- **Not installed anywhere yet:** GitHub asks where to install the app.
  Pick your organization and the repositories the tools should reach.
- **Already installed:** GitHub asks you to authorize the app. If your
  GitHub account reaches more than one of its installations, Kindgi asks
  you to **Choose the account to connect**: pick the one this connection
  uses, such as **Use acme**. If it reaches only one, Kindgi uses that
  one without asking.

GitHub sends you back to Kindgi, and the connection shows your
organization. Kindgi keeps an installation only if your own GitHub account
reaches it.

**To install the app on another account,** such as a second
organization, choose **Install on another account**. Kindgi offers it on
the **Connect GitHub** page, before you go to GitHub, and beside the
installations to choose from. Once the app is installed
anywhere, connecting never shows GitHub's install page by itself, so this
is the way there.

- **When the GitHub account you signed in with reaches none of the app's
  installations, or not the one you picked,** Kindgi says **The app isn't
  reachable from your GitHub account**
  (`connection-installation-unreachable`). Choose **Install on another
  account** and install it on an account you manage, or ask an owner of
  the account it's installed on.
- **When your organization makes installs wait for an owner's
  approval,** the connect fails with `connection-app-refused` until an
  owner approves the install on GitHub. Connect again once they have.
- **Only whoever started a connect can finish it,** signed in to Kindgi
  as themselves. Anyone else sees **Someone else started this sign-in**
  (`connection-not-yours`).

Calls then use short-lived tokens limited to the tool's permissions, over
the repositories you picked when you installed the app.

## Reconnecting

If an owner of the account the app is installed on takes a permission
away from it on GitHub, the next call that needs that permission finds
out, and the connection needs reconnecting. Until an admin connects it
again, the company's calls fail with `connection-missing`.

- **A reconnect stays on the connection's account.** Kindgi uses the
  app's installation there without asking, even when your GitHub account
  reaches several, and doesn't show the **Connect GitHub** page. If the
  app was uninstalled and installed again on that account, reconnecting
  picks up the new installation. If your account can't reach an
  installation on that account, the reconnect fails with
  `connection-installation-unreachable`. Choosing an installation on
  another account fails with `connection-account-mismatch`. To connect
  another account as well, connect again, not as a reconnect, and choose
  its installation, or install the app there
  ([4. Install it for the company](#4-install-it-for-the-company)): the
  company keeps a connection of its own for each account
  ([Choose a connection](../choose-a-connection/)).
- **A reconnect asks again for every permission the connection had,** so
  have an owner give the app back what it lost on GitHub first. Until
  then the reconnect is declined, naming what's missing, and the
  connection still needs reconnecting. To go on with less, disconnect,
  then connect again for what's left.

## Disconnecting

**Connections → Disconnect** stops Kindgi using the app at once and revokes
the short-lived tokens it holds
([How connections work](../reference/#disconnecting)). Connecting again
later goes through GitHub's authorization and gets the same installation
back, without installing it again.

**It doesn't uninstall the app from your organization.** The app keeps its
access to the repositories you picked until you uninstall it on GitHub:
your organization's **Settings → GitHub Apps → Configure → Uninstall**.
Uninstalling it there also removes the connection in Kindgi, through the
notice.
