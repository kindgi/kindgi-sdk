---
title: Let a store's staff ask and approve in WordPress
description: Connect a WordPress site to a project, so its staff ask the project's agents and decide approvals in wp-admin, each as themselves.
sidebar:
  order: 1
  label: WordPress
---

The Kindgi plugin for WordPress adds a **Kindgi** page to wp-admin. On it,
each person signed in to the site can:

- **ask** the project's agents, in conversations of their own;
- **approve or reject** what an agent waits on, a refund for example.

Each person acts as themselves. A decision names Jane, shown as "Jane, via
Acme store", never "the store".

This page sets it up:
- site sign-in, on a runtime you run (Kindgi Cloud has it on);
- the site in Kindgi;
- the plugin.

It also covers what the site's people can and can't do in Kindgi.

## On Kindgi Cloud

Site sign-in is on for every Kindgi Cloud workspace, so there's nothing to
turn on: skip
[Self-hosted: turn site sign-in on](#self-hosted-turn-site-sign-in-on).
The steps after it are the same, with two differences:
- **Register the site with the CLI signed in to Kindgi Cloud**
  ([Sign the CLI in](../../hosted/deploy-your-agent/#sign-the-cli-in)).
  It takes a workspace admin's key, with **How far it goes** set to
  **Admin** and **Where it works** to **Every project it can reach**. A
  **Member** key, or one for only one project, gets
  `403 permission-denied`.
- **The plugin's Kindgi URL is `https://platform.kindgi.com`.**

An agent on Kindgi Cloud can also work with a WooCommerce store without
the plugin, through the store's own API and its webhooks:

- **The `woocommerce` template:** `kindgi init --template=woocommerce`
  makes agents for a WooCommerce store, where a larger refund, a price
  change and publishing a product each wait for a person. A WooCommerce
  webhook starts its order review.
- **The store's actions as an MCP server's tools,** as
  [Give the agent the store's actions](#give-the-agent-the-stores-actions)
  shows. On Kindgi Cloud, that's an MCP server the store serves on the
  internet.

Without the plugin, a person approves what waits in the console or with
the CLI
([Approve it](../../guides/approvals/ask-before-a-tool-runs/#approve-it)).

## How the site signs its people in

- **The site vouches for its staff.** When Jane opens the page, the plugin
  signs a short statement: "the person signed in here is Jane, with these
  WordPress roles". The statement is signed with an Ed25519 key, lives 60
  seconds and can be used once.
- **Kindgi exchanges it for a session as Jane.** The plugin sends the
  statement server to server. Kindgi checks it against the key the site
  enrolled, and answers with a 15-minute session held to the site's one
  project.
- **No Kindgi token reaches the browser.** The page calls the plugin's
  routes on the site (`/wp-json/kindgi/v1/…`), and the plugin calls Kindgi.
- **People are matched by the site, never by email.** Kindgi knows each
  person by their site and a random id the plugin keeps for them. It never
  uses their WordPress user id, login name or email for that.

## Self-hosted: turn site sign-in on

Site sign-in needs a runtime on Kindgi 0.1.9 or later, and is off by
default. It needs two more settings in the runtime's environment:
- [authorization enforced](../../deploy/authorization/), which holds a
  site's people to its project;
- the runtime's public URL, which a site's statements carry as their
  audience.

```sh
KINDGI_SITE_SIGN_IN=true
KINDGI_OPENFGA_API_URL=http://kindgi-openfga:8080
KINDGI_PUBLIC_URL=https://kindgi.acme.example
```

Without either of the other two, the runtime refuses to start:

```text
KINDGI_SITE_SIGN_IN needs authorization enforced: a site's people are held to its project by it. Set KINDGI_OPENFGA_API_URL, or turn it off.
```

```text
KINDGI_SITE_SIGN_IN needs KINDGI_PUBLIC_URL: a site's statements carry it as their audience. Set it, or turn site sign-in off.
```

## Register the site

A tenant admin registers the site on the project its staff will use. The
plugin's **Kindgi → Settings** page shows the two addresses to register:
- the site's origin;
- its approvals URL.

```sh
pnpm exec kindgi sites register --project=<project-id> --name='Acme store' \
  --origin=https://acme-store.example \
  --approvals-url='https://acme-store.example/wp-admin/admin.php?page=kindgi&approval={approvalId}'
```

It prints the site and its one-time code, shown once and good for 15
minutes; `kindgi sites code <site-id>` gives a new one. Without
`--project`, this and each `kindgi sites` command below use the tenant's
default project. From code, the client's `projects.sites.register` does
the same.

- **`--name`** is how Kindgi shows the site's people: "Jane, via Acme
  store". Only a tenant admin sets it, never the site.
- **`--origin`** must be `https://`. An `http://` origin works only for a
  loopback address, in development.
- **`--approvals-url`** must be on the origin. Kindgi replaces `{approvalId}`,
  and its emails to the site's people link there.

These settings decide who may sign in and what they get. Each has a default,
and `kindgi sites update <site-id>` changes it later:

| Setting | Default | What it decides |
| --- | --- | --- |
| `--allowed-role` | `administrator`, `shop_manager` | The WordPress roles that may sign in at all, one flag for each. Any other role is refused. |
| `--role-map` | Both roles: `{"ask": true, "reviewer": "standard"}` | For each allowed role, as JSON or `@<file>`: whether it may ask the project's agents (`ask`), and the reviewer role it decides approvals with (`reviewer`; none when absent). A person with several allowed roles gets the most any of them gives. `--allowed-role` without `--role-map` keeps only the map's entries for the allowed roles: the default map's for a new site, the site's own on an update. An allowed role with no entry signs in to read the project only. |
| `--reviewer-ceiling` | `standard` | The highest reviewer role the site's people can have: `standard` or `senior`. |
| `--people-cap` | `50` | At most this many people from the site (1 to 10,000). |
| `--new-people-per-day` | `20` | At most this many new people a day (1 to 1,000). |
| `--vouching` | `on` | Whether Kindgi accepts the site's statements at all: `on` or `off`. |

- **Every person also reads the project.**
- **No setting gives more:** never editor or admin on the project, never a
  reviewer `admin`, and never a tenant role. A site can't publish agents,
  policies or approval rules.
- **A WooCommerce `customer` isn't in the defaults,** so a store's customers
  never become people in Kindgi.

## Install and connect the plugin

Each SDK release carries the plugin as `kindgi-<version>.zip`; its source is under
[`integrations/wordpress/kindgi`](https://github.com/kindgi/kindgi-sdk/tree/main/integrations/wordpress/kindgi).
It needs WordPress 6.4 or later and PHP 7.4 or later.

1. **Install it.** Download `kindgi-<version>.zip` from the SDK's
   [latest release](https://github.com/kindgi/kindgi-sdk/releases/latest),
   and upload it under **Plugins → Add Plugin → Upload Plugin** (**Add New
   Plugin** before WordPress 6.8). The `.sha256` file next to it checks the
   download (`sha256sum -c`). Or copy the folder to
   `wp-content/plugins/kindgi`. Then activate it.
2. **Connect.** An administrator, under **Kindgi → Settings**, pastes the
   one-time code and the Kindgi URL this server reaches, then chooses
   **Connect**. The plugin makes
   its signing key and sends Kindgi the public half. The page says
   "Connected: your staff can use the Kindgi page now."

About the Kindgi URL:
- **On Kindgi Cloud, it's `https://platform.kindgi.com`.**
- **It must be `https://`.** An `http://` URL works only to this computer
  (`localhost`), or from a local or development site
  (`WP_ENVIRONMENT_TYPE`).
- **It's kept only once Kindgi takes the code,** so a typo never breaks a
  working connection.
- **It can differ from Kindgi's public URL.** The site's statements carry
  the public one, which Kindgi gives the plugin when it connects.

### Where the signing key lives

- **Preferred: in `wp-config.php`, before you connect.**

  ```php
  define( 'KINDGI_SITE_SECRET_KEY', '…' ); // php -r 'echo base64_encode(random_bytes(32)), PHP_EOL;'
  ```

  An environment variable of the same name works too. A copy of the
  database (a backup, a staging clone) then carries neither the key nor a
  way to open the staff's cached sessions.
- **Without it,** the plugin keeps the key in a database option, which
  isn't autoloaded.
- **The site's address is part of the connection.** The plugin signs nothing
  when the site's address isn't the one it connected as, so a staging copy
  never vouches as production. When the site moves, connect it again with a
  new code.

## Who sees the page

- **The page needs `manage_woocommerce`** when WooCommerce is active, which
  means shop managers and administrators. Without WooCommerce, it needs
  `edit_others_posts`: editors and administrators. The `kindgi_capability`
  filter changes it.
- **Seeing the page isn't signing in.** Kindgi decides from the person's
  roles and the site's settings. On a site registered with the defaults, an
  editor who sees the page gets "None of these roles may sign in through
  this site".
- **The Approvals tab** shows only to someone whose roles give a reviewer
  role.

## What the staff see

**Ask:**
- **Their own conversations** with the project's agents: the ones they
  opened (`GET /v1/conversations?openedBy=me`). A conversation is titled
  with its first message.
- **The tools a turn called,** and what it waits for: "Waiting for a person
  to approve shop.acme-refund-order."

**Approvals:**
- **Waiting for you:** the project's approvals their reviewer role may
  decide. Each shows the tool, its arguments, who asked, when it expires and
  the role it needs.
- **Approve, or reject with a reason.** The page asks for the reason: "Say
  why you reject it."
- **Decided by you lately:** `GET /v1/approvals?decidedBy=me`.
- **From your link:** an approval opened from Kindgi's email
  (`?approval=<id>`).

## Reviewer email

With [`KINDGI_REVIEWER_EMAIL=on`](../../guides/approvals/decide-an-approval/#reviewer-email),
which Kindgi Cloud has, Kindgi emails the site's reviewers too:
- **At the address the site sends for them:** the person's WordPress email.
  The `kindgi_statement_email` filter changes it, or sends none.
- **The link opens the approval on the site's page** (its approvals URL),
  not in the console.
- **Nothing while the site signs nobody in:** while it's paused, not
  vouching or unregistered.

## What the record says

- **A decision names the person:** `decidedBy` is `user:<id>`, the Kindgi
  person the site made for them, shown as "Ada, via Acme store".
- **It keeps how they signed in:** `sessionProvider` is `site:<siteId>`.
- **It keeps the decider's name as it was** when they decided
  (`deciderName`). Renaming or removing the person later doesn't change
  decisions already made.

The audit record of each decision carries both.

## Four eyes

**By default, a person may approve a tool call they asked for.** To require
someone else, set `separateApprover` on the agent: see
[Ask before a tool runs](../../guides/approvals/ask-before-a-tool-runs/), under "Someone other
than whoever asked". The `woocommerce` template's store agent sets it for its
money tools. With it on, the person who asked sees "You asked for this;
another reviewer decides." instead of **Approve**.

**Inside one site, four eyes is one administrator's word.**
- A site vouches for its people, so whoever controls the site can sign in as
  any of them: as Jane to ask, and as Ada to approve. That includes its
  administrators, its plugins and theme, and its host.
- **Where two people must really decide,** require a reviewer role above
  the site's ceiling. A reviewer signed in to Kindgi directly then decides:

  ```ts excerpt
  conversationPolicy: {
    hitl: {
      tools: {
        overrides: {
          'shop.acme-refund-order': { mode: 'always_ask', requiredRole: 'senior' },
        },
      },
    },
  },
  ```

  `senior` is above the default ceiling, `standard`. For a site whose ceiling
  is `senior`, use `admin`.

- **The same goes for a tool that acts outside the store:** email to
  customers, a payment provider, a CRM. Approving it from the site would
  give whoever controls the site reach that the store alone doesn't have.

## A site's people in Kindgi

**Their sessions are limited.**
- They last 15 minutes and are held to the site's project: they read nothing
  above it (the tenant, orgs, teams).
- Kindgi doesn't refresh them: the plugin signs the person in again.

  ```text
  A session limited to a project or a role is not refreshed: get a new one where you got this one
  ```

  The code is `limited-session-not-refreshable`.
- They mint no API keys:

  ```text
  This session is limited (to project …), and a limited session mints no keys
  ```

  The code is `limited-session-cannot-mint`.
- Kindgi asks them for no second factor, even where the workspace
  [requires one](../../deploy/self-hosted/sign-in/#a-second-factor): the site owns it.

**Their grants come from the site, and only from it.**
- A route that would give one of them a grant, a tenant role, a project or
  team membership or its role, or a reviewer role is refused with 403
  `site-person-grants-managed`:

  ```text
  This person is signed in by a site: they hold only what their site's sign-in gives them
  ```

- So is minting them an API key, with its own message:

  ```text
  This person is signed in by a site: they act only through the sessions their site's sign-in gives, which end when the site is paused or unregistered, so they get no API key
  ```

- So is a route that would take one away, since the site would give it back
  at their next sign-in:

  ```text
  This person is signed in by a site, which gives their grants back at their next sign-in: remove the person, change their role on the site, or pause the site instead
  ```

- **To change what they get,** change their role in WordPress: the plugin
  tells Kindgi at once. A change to the site's role map applies at each
  person's next sign-in, so within 15 minutes for someone using the page.
- **In the people list,** a site's person shows as "Jane, via Acme store",
  with no grants of their own: theirs come from the site.
- **Their name follows the site.** Each sign-in shows them as the site names
  them then, or as "A person, via Acme store" when it sends no name.

## Pause, re-key or remove

- **Pause the site** (`kindgi sites pause <site-id>`). It ends every
  session the site opened, and refuses its sign-ins until
  `kindgi sites resume <site-id>`. The page says "This site is paused: a
  tenant admin resumes it".
- **Get a new code** (`kindgi sites code <site-id>`). Connecting with it
  replaces every key the site has and ends its sessions. Use it when the
  site moves, or its key may be out.
- **Revoke one key** (`kindgi sites revoke-key <site-id> <kid>`). It ends
  every session the site opened. `kindgi sites get <site-id>` lists the
  site's keys, with thumbprints to compare with the plugin's key id under
  **Kindgi → Settings**.
- **Remove one person** (`kindgi people remove <user-id>`). Their next
  sign-in is refused, "This person was removed: their site can't sign them
  in again", until a tenant admin lets them back in.
- **Let them back in**
  (`kindgi sites restore-person <site-id> <user-id>`; runtime 0.1.10 or
  later). They're the same person, with their history, and their next
  sign-in gives them what their roles give then.
  `kindgi people list --include-removed` finds their id. It's for someone
  removed in Kindgi: someone who left the store stays gone (below). It's
  refused when they also sign in another way (through another site, or the
  tenant's own sign-in), since that would let them in there too: add them
  again instead, as a new person.

## When someone leaves the store

The plugin tells Kindgi when a person it knows changes in WordPress, so
someone who can't open the page any more doesn't keep what they had:

- **Deleting their WordPress user** is for good. So is removing them from
  the site, on a multisite network, and erasing their data with WordPress's
  personal-data tools. Kindgi ends their grants, their reviewer role (and
  its emails) and every session they hold, so a page they still have open
  can't approve anything. Then it refuses them: "This person was removed:
  their site can't sign them in again". The plugin forgets them too, so if
  they come back, they're a new person in Kindgi, without the history.
- **Taking away their roles** ends the same, but not for good. Give them a
  role that may sign in again, and they're the same person in Kindgi, with
  their history.
- **If Kindgi can't be reached,** the change waits. WordPress tries again
  on its own (wp-cron), less often each time, and never gives up. Until it
  gets through, the person keeps what they had, and **Kindgi → Settings**
  lists the change under "Waiting to reach Kindgi".
- **Once a day,** the plugin checks everyone Kindgi knows against WordPress,
  so a change no hook saw still reaches Kindgi: a role edited in the
  database, WooCommerce's roles removed when it's deleted with all its
  data, or a user deleted from a network's admin where the plugin is active
  per site.
- **The retries and the daily check need wp-cron.** On a site with
  `DISABLE_WP_CRON` set, a system cron must call `wp-cron.php`.
- **With the plugin deactivated,** none of this happens. Pause the site in
  Kindgi if the plugin stays off.

## When a sign-in is refused

Kindgi answers 401 `site-sign-in-refused` with a reason in
`details.reason`, and the page shows its message:

```json
{
  "error": {
    "code": "site-sign-in-refused",
    "message": "This statement was already used",
    "details": { "reason": "replayed" },
    "requestId": "…"
  }
}
```

| `reason` | Message | What to do |
| --- | --- | --- |
| `not-verified` | The statement couldn't be verified: check the site's id, key and signature | Connect the site again with a new code. Kindgi says nothing more: an unknown site, an unknown or retired key, a bad signature, a statement that doesn't parse or has the wrong header (not EdDSA, the wrong `typ`, no `kid`), and one without `iat`, `exp`, `jti` or `sub` all read the same. |
| `site-paused` | This site is paused: a tenant admin resumes it | Resume the site: `kindgi sites resume <site-id>`. |
| `site-not-vouching` | This site doesn't sign its people in | Turn it back on, `kindgi sites update <site-id> --vouching=on`, unless the site was unregistered. |
| `wrong-audience` | The statement's audience isn't this deployment's: expected … | The runtime's `KINDGI_PUBLIC_URL` changed since the site connected. Connect it again with a new code. |
| `expired` | The statement has expired | Check the site's clock: Kindgi allows 30 seconds of difference. |
| `issued-in-the-future` | The statement's `iat` is in the future | Check the site's clock. |
| `too-long-lived` | A statement lives at most 60 s | Something other than the plugin signs the site's statements: use the plugin. |
| `replayed` | This statement was already used | The plugin never sends one twice. A copied statement is refused. |
| `role-not-allowed` | None of these roles may sign in through this site | Add the role: `kindgi sites update <site-id>`, with an `--allowed-role` for it and for each role the site keeps. A person who had signed in before loses what their roles gave them. |
| `person-removed` | This person was removed: their site can't sign them in again | If they were removed in Kindgi, a tenant admin lets them back in (runtime 0.1.10 or later): `kindgi sites restore-person <site-id> <user-id>`. Someone who left the store comes back as a new person. |
| `people-cap` | This site has as many people as it may: a tenant admin can raise its cap | Raise `--people-cap` or `--new-people-per-day` (`kindgi sites update <site-id>`). |

Too many sign-ins at once get 429, with `Retry-After`.

## When WooCommerce turns off a webhook to Kindgi

A store's webhooks to Kindgi (to a receive URL, `/v1/hooks/…`, like the
`woocommerce` template's order trigger) can stop. WooCommerce turns a
webhook off after 7 refused deliveries in a row, and never resends one it
didn't deliver. Where Kindgi limits webhook receives (Kindgi Cloud does),
it answers a delivery past the limit with 429 and `Retry-After`, which
WooCommerce counts as a refusal like any other. When
WooCommerce has turned one off, **Kindgi → Settings** says so, with when,
and a **Turn it on again** button for someone who manages WooCommerce. It
starts the webhook's count of refusals over. Turned on in WooCommerce's own
webhook screen instead, it keeps its count until a delivery gets through, so
a refusal before then turns it off again. Orders from while it was off
aren't resent.

## Give the agent the store's actions

WordPress's [Abilities API](https://developer.wordpress.org/apis/abilities-api/)
(WordPress 6.9 and later) and the
[MCP Adapter](https://github.com/WordPress/mcp-adapter) plugin can expose
the store's actions (look up an order, refund it) as
[an MCP server's tools](../../guides/tools/mcp-servers/):

- **Register your own adapter server,** and list each ability on it: the
  abilities it names become its MCP tools (see
  [Configuring custom MCP servers for your plugins](https://developer.wordpress.org/news/2026/02/from-abilities-to-ai-agents-introducing-the-wordpress-mcp-adapter/)).
  Register its endpoint with Kindgi, and each ability becomes its own
  tool, named `<endpoint>.<ability, with / as ->`: with an endpoint named
  `shop`, `acme/refund-order` becomes `shop.acme-refund-order`. Each tool
  then gets its own approval rule.
- **Never give an agent the default server's `execute-ability`.** It
  ["executes any WordPress ability with provided parameters"](https://github.com/WordPress/mcp-adapter/blob/trunk/docs/guides/default-server.md),
  so one approval rule would cover every action.
- **Set `meta.mcp.public` to `false`** on every ability with side effects.
  The default server then never exposes it, even when the ability is
  otherwise public, and only your own server does.
- **Give read-only tools `never_ask`.** An MCP tool always counts as one
  that changes things, so, with `hitl.tools` set, a gate asks before it
  unless an override says otherwise:

  ```ts excerpt
  conversationPolicy: {
    hitl: {
      tools: {
        default: 'always_ask',
        overrides: { 'shop.acme-order-lookup': 'never_ask' },
      },
      separateApprover: { overrides: { 'shop.acme-refund-order': true } },
    },
  },
  ```

- **Give money tools no automatic retries on a tool error.** A retry is a
  new call, with its own approval and its own idempotency key. If the first
  call refunded before it failed, the retry refunds again. Have the tool
  check the store's existing refunds first.

## What the plugin keeps on the site

The plugin's
[README](https://github.com/kindgi/kindgi-sdk/tree/main/integrations/wordpress/kindgi#what-the-plugin-stores)
lists what it keeps, and how WordPress's personal-data tools cover it.

Erasing a person with those tools forgets them on the site, and tells
Kindgi they left, which ends their access there for good. Kindgi keeps its
own record of the person, and their name stays on the records they're part
of, decisions included.
