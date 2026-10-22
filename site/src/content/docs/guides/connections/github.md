---
title: GitHub
description: Create your company's own GitHub App, register it with Kindgi, and install it on your organization, so tools can work on its repositories.
sidebar:
  order: 20
  label: GitHub
---

When you finish this page, tools in your projects can work on the
repositories you picked, such as listing issues and adding labels, through
your company's own GitHub App. You create the app by hand on GitHub,
register it with Kindgi once, and install it on your organization.

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
- **Webhook:** untick **Active** for now. You turn it on in step 3, with
  the address Kindgi gives you.
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

In the console, open your workspace's **App registrations** page and choose
**Add an app → GitHub**:

- **App ID**, **slug** and **Client ID:** from the app's page on GitHub.
- **Client secret**, **private key** and **webhook secret:** the names you
  stored them under.
- **Projects:** the projects whose runs may use it. Leave it empty for all
  of them.

The registration then shows its **notices address**. Back on GitHub, in
the app's **General** settings, tick **Webhook → Active**, enter that
address as the **Webhook URL** and the webhook secret from step 2 as the
**Secret**, and save. GitHub then sends Kindgi a signed notice when the app
is uninstalled or suspended
([Notices from the app](../reference/#notices-from-the-app)).

## 4. Install it for the company

An admin connects the app for the company. In a project, open
**Connections → Connect → GitHub**, and choose **For the company**. GitHub
asks where to install the app: pick your organization and the repositories
the tools should reach. GitHub sends you back to Kindgi, and the connection
shows your organization.

Each call then gets its own short-lived token, narrowed to that tool's
permissions and the repositories you picked.

## Disconnecting

**Connections → Disconnect** stops Kindgi using the app at once and revokes
its live token
([How connections work](../reference/#disconnecting)).

**It doesn't uninstall the app from your organization.** The app keeps its
access to the repositories you picked until you uninstall it on GitHub:
your organization's **Settings → GitHub Apps → Configure → Uninstall**.
Uninstalling it there also removes the connection in Kindgi, through the
notice.
