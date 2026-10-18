---
title: "A WooCommerce store's agents on Kindgi Cloud"
description: "Put the WooCommerce template's agents on Kindgi Cloud, let the store's staff ask and approve in wp-admin, each as themselves, and have each new order reviewed."
sidebar:
  order: 3
---

A store's staff ask an agent about orders and refunds without leaving
wp-admin. It refunds small amounts on its own. A larger refund waits until
someone else on the staff approves it, and the record names both of them.
Each new order gets a short review. The agents run on Kindgi Cloud, so
nothing runs on your machine but your coding agent and the Kindgi CLI.

**What you'll build,** one chapter at a time:

1. your Kindgi Cloud workspace;
2. a WordPress user for the store agent;
3. the store's agents, from Kindgi's WooCommerce template, on Kindgi Cloud;
4. the Kindgi plugin in wp-admin, connected to your workspace;
5. a small refund the store agent makes on its own, asked for from wp-admin;
6. a big refund that waits for a second person on the staff;
7. a short review of each new order;
8. the project in production.

**You need:**

- **A coding agent** that can run commands in a folder on your machine:
  Claude Code, Cursor, Codex or similar.
- **Node 22.12 or later.** Docker isn't needed: nothing of Kindgi's runs on
  your machine.
- **A WooCommerce store on a public https address,** with WordPress 6.4 or
  later and PHP 7.4 or later, where you can add plugins and users. Use a
  staging copy, never the live store, until you've seen every chapter work.
- **An API key from your AI provider** (Anthropic, OpenAI, Gemini, Groq or
  OpenRouter), made for this tutorial, with a spending limit.
- **A second person's address,** or a second address of your own, for the
  staff member who asks for a refund in chapter 6.

What the store agent says reads differently for you: your model writes it.
Your order numbers and amounts differ too.

## 1. Your Kindgi Cloud workspace

### The goal

A workspace of your own on Kindgi Cloud, and the Kindgi CLI on your machine
signed in to it, so your coding agent can deploy to it.

:::note[What only you do]
**Sign up.** Open
[Kindgi Cloud's sign-up page](https://platform.kindgi.com/cloud/signup) and
follow its steps. When your workspace is ready, an email says so, with a
link to sign in to its console. You're the workspace's first admin.

**Make a key for the CLI.** In the console, open **API keys** and **Create
a key**. Under **How far it goes**, choose **Admin**. Under **What it can
change**, tick **Trust signing keys** and **Store secrets**, then choose
**Create key**. The key shows once: **Copy** it.

**Sign the CLI in, in a terminal of your own.** Paste the key at the prompt,
which doesn't show it:

```sh
read -rs KINDGI_API_TOKEN && export KINDGI_API_TOKEN
npx --yes @kindgi/cli@0.1 auth login --url=https://platform.kindgi.com
npx --yes @kindgi/cli@0.1 auth whoami
```

`auth whoami` shows who the key acts as: you. The CLI keeps the key in
`~/.kindgi/config.json`, and your coding agent uses that sign-in from then
on. The key itself never goes into the chat.
:::

### See it in Kindgi's console

**Dashboard** shows your workspace's default project, **Default**. Your
agents go there in chapter 3.

```text
CAPTURE: the console's Dashboard for a new workspace
```

## 2. A WordPress user for the store agent

### The goal

A WordPress user that belongs to the store agent alone: a **Shop Manager**,
which can manage orders and products but not the site. The store agent signs
in to the store as this user, never as you, so everything it does there is
recorded under its own name.

:::note[What only you do]
**Make the user.** In wp-admin, go to **Users → Add User** (**Add New User**
before WordPress 6.8). Name it `shop-agent`, give it the **Shop Manager** role,
and add it.

Its Application Password comes in chapter 3, when your agent asks for it.
:::

### See it in your store

**Users** lists `shop-agent`, a Shop Manager.

## 3. The store's agents, on Kindgi Cloud

### The goal

The WooCommerce template's agents in your workspace's default project:

- **the store agent,** which your staff talk to: it looks orders up, refunds
  up to 100 on its own, and asks a person before a larger refund, a price
  change or publishing a product;
- **the order reviewer,** which reads each new order and writes a short
  review for the staff. It can look orders up, and nothing else.

Both sign in to your store as `shop-agent`.

### Ask your coding agent

Open your coding agent in an empty folder, and paste:

```text
Make a Kindgi pack for my WooCommerce store with `npx --yes @kindgi/cli@0.1 init acme-shop --template=woocommerce`, and run its tests with `kindgi test`. Read the project's README and follow it, with these differences: the store's agents run on Kindgi Cloud, where the Kindgi CLI is already signed in, so there's no `kindgi dev`.
- Connect the pack to my store, following the README's "Connect your store", at the scope of my workspace's default project (`--scope=project:<its id>`), on `prod` (`--env=prod`): WOO_STORE_URL is https://shop.acme.example and WOO_USER is shop-agent. WOO_APP_PASSWORD is a secret: take it from my clipboard into `kindgi secrets set WOO_APP_PASSWORD --env=prod --scope=project:<its id> --from-stdin` when I say I've copied it. Never print it.
- Then my model key, for the provider I name: take it from my clipboard into `kindgi secrets set <its key's name> --env=prod --scope=tenant --from-stdin` the same way. Then register that provider on `prod` with `kindgi providers register --preset=<its preset> --env=prod`, as the kindgi-authoring-providers skill says.
- Make a signing key with `kindgi key create acme-agency` and trust it with `kindgi key trust acme-agency`. Then deploy the pack to the default project with `kindgi deploy --hosted --env=prod`, signing with that key, and wait until the deploy says the pack service is ready.
Tell me whenever you need something from me, and wait for me. At the end, tell me the agents' ids.
```

Use your store's own address for `https://shop.acme.example`.

:::note[What only you do]
**Hand over two keys, without pasting them into the chat.** The agent asks
for each in turn and moves it from your clipboard straight into Kindgi:

- **The store's Application Password,** made when the agent asks for it. In
  wp-admin, open **Users → All Users → shop-agent**, find **Application
  Passwords**, name it `kindgi`, and choose **Add Application Password**
  (**Add New Application Password** before WordPress 6.8). WordPress shows it
  once: copy it, and say "copied".
- **Your model key:** with your AI provider, create an API key for this
  tutorial and copy it. When the agent asks which provider, answer with its
  name and "copied": "Anthropic, copied", say.

Kindgi Cloud keeps both in your workspace's secrets, and hands the store's
password only to the tools that declare they need it.
:::

### What your agent should say

`kindgi deploy --hosted` builds the pack on Kindgi Cloud, streams the build,
deploys what it built, and waits until the pack service is ready:

```text
CAPTURE: kindgi deploy --hosted for acme-shop, from the build to the pack service ready
```

### See it in Kindgi's console

- **Tools:** six under `acme-shop.woo.`: five that work on the store, and
  the check that reads each new order (`acme-shop.woo.check-order-event`).
- **Agents:** the store agent (`acme-shop.store-agent`) and the order
  reviewer (`acme-shop.order-reviewer`).

```text
CAPTURE: the console's Tools for acme-shop on Kindgi Cloud
```

For reference, the pack looks like this, without its tests and the store in
memory they run against (`lib/fake-store.ts`):

```text
acme-shop/
├── kindgi.config.ts
├── lib/woo.ts                                  # the WooCommerce REST client the tools share
├── tools/
│   ├── find-orders/index.ts                    # look orders up (read-only)
│   ├── refund/index.ts                         # refund up to 100, no approval
│   ├── refund-large/index.ts                   # refund any amount, approved first
│   ├── set-price/index.ts                      # change a price, approved first
│   ├── publish-product/index.ts                # publish a product, approved first
│   └── check-order-event/index.ts              # check an order event before an agent sees it
├── guardrails/no-customer-contact-details/     # no email address or phone number in an answer
├── agents/store-agent/  agents/order-reviewer/
├── flows/order-review/index.ts                 # order event → check → order reviewer
└── fixtures/order-created.json                 # a sample order event
```

The tools call your store's REST API from Kindgi Cloud, as `shop-agent` with
its Application Password. That's why the store needs a public https
address.

## 4. The Kindgi plugin, connected

### The goal

A **Kindgi** page in wp-admin, where each person on the staff asks the store
agent and decides what it waits on, signed in as themselves. The plugin
vouches for whoever is signed in to WordPress, and Kindgi gives them a short
session on the store's project.

:::note[What only you do]
**Install the plugin.** Download `kindgi-<version>.zip` from the Kindgi
SDK's [latest release](https://github.com/kindgi/kindgi-sdk/releases/latest).
The `.sha256` file next to it checks the download (`sha256sum -c`). In
wp-admin, go to **Plugins → Add Plugin → Upload Plugin** (**Add New
Plugin** before WordPress 6.8), choose the zip, then **Install Now** and
**Activate Plugin**.

**If you can edit the store's `wp-config.php`,** give the plugin its signing
key there before you connect, as
[where the signing key lives](../../guides/approvals/ask-and-approve-in-wordpress/#where-the-signing-key-lives)
shows. Then a copy of the database, a backup or a staging clone, carries no
key.

**Open Kindgi → Settings.** It shows two addresses, **Origin** and
**Approvals URL**. Give both to your coding agent.
:::

### Ask your coding agent

```text
Register my store as a site with `kindgi sites register`, on my workspace's default project, where the acme-shop pack is, so its staff can sign in from WordPress: display name "Acme Shop", and the origin and approvals URL that I paste from the plugin's settings page. Keep the defaults for who may sign in. Give me the one-time code it prints, and tell me until when it works.
```

### What your agent should say

```text
CAPTURE: the site registered, with its one-time code and how long it lasts
```

:::note[What only you do]
**Connect.** Under **Kindgi → Settings**, paste the code under **One-time
code**, and `https://platform.kindgi.com` under **Kindgi URL**. Choose
**Connect**. The code is good for 15 minutes: after that, ask your coding
agent for a new one (`kindgi sites code`).
:::

### See it in your store

**Kindgi → Settings** says "Connected: your staff can use the Kindgi page
now." The **Kindgi** page has two tabs, **Ask** and **Approvals**.

```text
CAPTURE: Kindgi → Settings, connected
```

### How your staff sign in

With the defaults, an administrator or a shop manager may sign in, ask the
project's agents, and review at the `standard` role. Any other role is
refused.

When someone opens the page, the plugin signs a short statement: the person
signed in here, with these WordPress roles. Kindgi checks it against the
key the site enrolled, and answers with a 15-minute session held to the
site's one project. No Kindgi token reaches the browser. Each person is a
Kindgi person of their own, matched by the site, never by email.

[Let a store's staff ask and approve in WordPress](../../guides/approvals/ask-and-approve-in-wordpress/)
has the rest: the site's settings, pausing, re-keying and removing it, and
what the plugin keeps.

## 5. A small refund, asked for from wp-admin

### The goal

You ask the store agent for a refund of 40, on the **Kindgi** page. It's 100
or less, so the agent makes it on its own.

### Ask in wp-admin

Find a paid order of 40 or more in **WooCommerce → Orders**. On **Kindgi →
Ask**, ask:

```text
Refund 40 on order 1043: the jacket arrived torn.
```

Use your order's number for `1043`.

### See it in your store

The order's page lists the refund under its items, by `shop-agent`, with
the reason underneath. No money moved through a payment gateway: the template
records refunds in WooCommerce only, unless you turn the gateway on
(`WOO_REFUND_THROUGH_GATEWAY`, in the project's README).

```text
CAPTURE: the order's refund in WooCommerce
```

### See it in Kindgi's console

**Runs:** the run at the top, **Completed**. Under **What happened**, it
looked the order up, then made one call to `acme-shop.woo.refund`.

```text
CAPTURE: the run in the console, with the order looked up and the refund made
```

## 6. A big refund waits for a second person

### The goal

A refund over 100 waits for a person to approve it, and not the person who
asked. Jane, on the staff, asks for it. You approve it. The record names
both of you.

:::note[What only you do]
**Add Jane to the staff.** In wp-admin, go to **Users → Add User** (**Add New
User** before WordPress 6.8), and make a user for Jane with the **Shop
Manager** role and their email address.
:::

### Ask in wp-admin, as Jane

In a private window, sign in to wp-admin as Jane. On **Kindgi → Ask**, ask
for a refund over 100, on another paid order of 150 or more:

```text
Refund 150 on order 1044: the daypack never arrived.
```

The agent answers that the refund waits for a person to approve it. On
**Approvals**, Jane sees it with "You asked for this; another reviewer
decides." instead of **Approve**.

### Approve it, as you

In your own window, open **Kindgi → Approvals**. **Waiting for you** has
the refund: the tool, its arguments, who asked, when it expires and the
role it needs. Choose **Approve**.

### See it in your store

The order's page lists a refund of 150, by `shop-agent`.

### See it in Kindgi's console

Under **Approvals**, the refund says **Approved**. Open it: **The whole
record** has who asked (`requestedBy`) and who decided (`decidedBy`), each
the Kindgi person the site made for them. The decision also keeps your name
with the store's (`deciderName`: your name, then ", via Acme Shop"), and
how you signed in (`sessionProvider`: `site:` and the site's id).

```text
CAPTURE: the decided approval in the console, with its whole record
```

:::note[When two people must really decide]
A site vouches for its own staff, so whoever controls the site (its
administrators, its plugins, its host) could sign in as Jane and as you.
If a refund must never be decided through the store alone, give the refund
tools a reviewer role above the site's ceiling: then only someone signed in
to Kindgi directly can decide. [Four eyes](../../guides/approvals/ask-and-approve-in-wordpress/#four-eyes)
shows how.
:::

## 7. Each new order gets a review

### The goal

Each new order in the store starts the order reviewer on Kindgi Cloud. It
checks the order in code before any model sees it, then writes a short
review.

### Ask your coding agent

```text
Have each new order in my store start the acme-shop order-review flow, following the README's "Start it from WooCommerce". Register the webhook trigger on Kindgi Cloud, and give me the receive URL and the signing secret it prints, so I can add the webhook in WooCommerce.
```

### What your agent should say

```text
CAPTURE: kindgi webhooks register on Kindgi Cloud: the receive URL and the signing secret
```

:::note[What only you do]
**Add the webhook in WooCommerce.** Go to **WooCommerce → Settings →
Advanced → Webhooks → Add webhook**, and fill it in:

- **Name:** Kindgi order review
- **Status:** Active
- **Topic:** Order created
- **Delivery URL:** the receive URL
- **Secret:** the signing secret
- **API version:** WP REST API Integration v3

Save it. WooCommerce sends a test request, and Kindgi answers it without
starting a run.

**Place an order,** as a customer would, on the shop's own pages. Cash on
delivery needs no payment account: turn it on under **WooCommerce →
Settings → Payments** if it's off.
:::

### See it in Kindgi's console

**Runs** has a run of `acme-shop.order-review` that the webhook
"WooCommerce orders" started (**Started by**), with the order reviewer's
review.

```text
CAPTURE: the webhook-started review in the console
```

## 8. In production

### The goal

The project in production, so its runs are the store's real work, not
tests.

:::note[What only you do]
**Go live.** In the console, open the project's **Dashboard**. Use **Go
live** on its **Production** card, and **Go live** again to confirm. Do
this yourself: it's the step that makes the store agent's work real, so
it's a person's decision.
:::

### See it in Kindgi's console

The **Production** card says **Live**, and since when. Runs from then on
count as live. **Take out of production**, on the same card, makes the
project's runs staging again.

How many of your projects can be in production at once is in
[Kindgi Cloud's limits](../../hosted/limits/#projects-in-production).

## If something looks wrong

- **The store agent can't sign in to the store.** Some hosts strip the
  `Authorization` header that the Application Password travels in. In
  wp-admin, **Tools → Site Health** then says "The authorization header is
  missing", and your host can pass it through again.
- **The store agent's calls never reach the store.** A host firewall, a WAF
  or a security plugin may refuse requests from cloud addresses, and its log
  shows them refused. Let requests to the store's REST API (`/wp-json/wc/v3/`)
  through.
- **Kindgi → Settings can't connect.** `WP_HTTP_BLOCK_EXTERNAL` in
  `wp-config.php`, or a security plugin, may block WordPress's own requests
  to `platform.kindgi.com`. Allow that host.
- **The Kindgi page says "None of these roles may sign in through this
  site".** The person's WordPress role isn't one the site lets in: by
  default, administrators and shop managers.
- **No review after an order.** WooCommerce sends deliveries from a queue,
  when WordPress runs its scheduled tasks. **WooCommerce → Status →
  Scheduled Actions** shows them pending as
  `woocommerce_deliver_webhook_async` until it does.
- **WooCommerce turned the webhook off.** It does after 7 refused deliveries
  in a row, and never resends one. **Kindgi → Settings** says so and can
  turn it on again
  ([when WooCommerce turns off a webhook](../../guides/approvals/ask-and-approve-in-wordpress/#when-woocommerce-turns-off-a-webhook-to-kindgi)).

## What's next

- **Another client's store:** give each client an org and a project, and
  deploy a copy of the template into it
  ([organize by org and project](../../guides/projects/organize-by-org-and-project/#deploy-a-clients-pack-into-its-project)).
- [Let a store's staff ask and approve in WordPress](../../guides/approvals/ask-and-approve-in-wordpress/):
  the site's settings, who may sign in, pausing and removing a site.
- [Ask before a tool runs](../../guides/approvals/ask-before-a-tool-runs/):
  the approval rules the store agent uses.
- [Start runs from webhooks](../../guides/webhooks/start-runs-from-webhooks/):
  the order trigger, and what Kindgi does with each delivery.
