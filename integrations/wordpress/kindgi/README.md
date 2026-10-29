# Kindgi for WordPress

A WordPress plugin that brings a store's staff to your Kindgi agents. In wp-admin, each person signed in to WordPress can:

- **ask** the project's agents, in conversations of their own;
- **approve or reject** what an agent is about to do, for example a refund, when the action needs a person.

Each person acts as themselves. Kindgi's record says "approved by Jane, via Acme store", never "approved by the store".

## How it works

- **The site vouches for its staff.** When Jane opens the Kindgi page:
  1. The plugin signs a short statement: "the person signed in here is Jane, with these WordPress roles".
  2. It sends the statement to Kindgi, server to server.
  3. Kindgi exchanges it for a 15-minute session as Jane, limited to the site's project. What she can do there comes from her roles on this site, under the ceiling the site was registered with.
- **Nothing reaches the browser but this site's own pages.** The page calls the plugin's routes (`/wp-json/kindgi/v1/…`), and the plugin calls Kindgi. No Kindgi token is ever in a browser.
- **People are matched by the site, never by email.** Each person is a random id the plugin keeps for them (`kindgi_subject`), never their WordPress user id, login name or email.

## Requirements

- **WordPress** 6.4 or later.
- **PHP** 7.4 or later, with sodium. WordPress ships a fallback for PHP builds without ext/sodium.
- **Kindgi with site sign-in on:** Kindgi Cloud has it on. A runtime you run needs:
  - `KINDGI_SITE_SIGN_IN=true`;
  - authorization enforced (`KINDGI_OPENFGA_API_URL`);
  - `KINDGI_PUBLIC_URL`.
  Without the last two, the runtime refuses to start.

## Install and connect

1. **Install the plugin.** Download `kindgi-<version>.zip` from the Kindgi SDK's [latest release](https://github.com/kindgi/kindgi-sdk/releases/latest) and upload it under **Plugins → Add Plugin → Upload Plugin** (**Add New Plugin** before WordPress 6.8); the `.sha256` file next to it checks the download (`sha256sum -c`). Or copy this folder to `wp-content/plugins/kindgi`. Then activate it. From a checkout, `node scripts/wordpress-plugin-zip.mjs <out dir>` builds the same zip.
2. **Read this site's two addresses** under **Kindgi → Settings**: its origin, and its approvals URL (`…/wp-admin/admin.php?page=kindgi&approval={approvalId}`).
3. **Register the site in Kindgi**, on the project its staff will use. A tenant admin does this. On Kindgi Cloud, that's a workspace admin, with the CLI signed in there with an Admin key for every project it can reach:

   ```sh
   kindgi sites register --project=<project-id> --name='Acme store' \
     --origin=https://acme-store.example \
     --approvals-url='https://acme-store.example/wp-admin/admin.php?page=kindgi&approval={approvalId}'
   ```

   The command prints the one-time code, good for 15 minutes; `kindgi sites code <site-id>` gives a new one.

   Registering does the following:
   - **Who may sign in:** by default, WordPress `administrator` and `shop_manager`. A WooCommerce `customer` never becomes a person in Kindgi.
   - **What they get:** each may ask the project's agents and review approvals as a `standard` reviewer.
   - **Changing it:** set `--allowed-role`, `--role-map` and `--reviewer-ceiling` when registering, or later with `kindgi sites update <site-id>`.
4. **Connect.** Paste the one-time code under **Kindgi → Settings**, along with the Kindgi URL this server reaches (`https://platform.kindgi.com` on Kindgi Cloud). The plugin makes its signing key and sends Kindgi the public half. Your staff can use the **Kindgi** page from then on.
   - The URL must be `https://`. An `http://` URL works only to this computer (`localhost`) or from a local or development site (`WP_ENVIRONMENT_TYPE`).
   - It's kept only once Kindgi takes the code, so a typo never breaks a working connection.

### The signing key

- **Preferred: keep the key out of the database.** Set it in `wp-config.php` before connecting:

  ```php
  define( 'KINDGI_SITE_SECRET_KEY', '…' ); // php -r 'echo base64_encode(random_bytes(32)), PHP_EOL;'
  ```

  An environment variable of the same name works too. A copy of the database (a backup, a staging clone) never carries `wp-config.php` or the environment.
- **Without one,** the plugin keeps the key in a database option, which isn't autoloaded. Connecting again with a new code replaces it.
- **Its id** shows under **Kindgi → Settings**: the key's RFC 7638 thumbprint. `kindgi sites get <site-id>` lists the site's keys by the same id, so you can tell which one to revoke.
- **The site's address is part of the deal.** The plugin signs nothing when `home_url()` isn't the address the site connected as, so a staging copy of the site never vouches as production. If the site moves, connect it again with a new code.

## Who sees the page

- **The page needs `manage_woocommerce` when WooCommerce is active** (shop managers and administrators), and `edit_others_posts` otherwise (editors and administrators). Authors, contributors and customers never see it. Change it with the `kindgi_capability` filter.
- **Kindgi decides the rest from the person's roles on this site.** A role the site wasn't registered to allow is refused there.
- **The Approvals tab** shows only for someone whose roles give a reviewer role.
- **Notification address:** each statement carries the person's email, for Kindgi's "an approval is waiting" mail only. Change it, or send none, with the `kindgi_statement_email` filter.
- **A changed role counts at once.** The plugin tells Kindgi when a person's roles change, so what they get there follows. Losing every role the site allows ends their grants, reviewer role and sessions at Kindgi. The same roles back bring the same person back.
- **When someone leaves, Kindgi is told, for good.** Deleting their user, removing them from the site (on a network), or erasing their data ends their grants, reviewer role and sessions at Kindgi, and Kindgi refuses them from then on.
- **A change that can't reach Kindgi waits.** WordPress tries it again on its own (wp-cron), less often each time, and never gives up. **Kindgi → Settings** lists it under "Waiting to reach Kindgi". Once a day the plugin also checks everyone Kindgi knows against WordPress, for changes no hook saw: a role edited in the database, WooCommerce's own roles removed when it's deleted with all its data (`WC_REMOVE_ALL_DATA`), or a user deleted from a network's admin where this plugin is active per site. Until that check runs, such a person keeps what they had at Kindgi.
- **Both need wp-cron to run.** On a site with `DISABLE_WP_CRON` set, a system cron must call `wp-cron.php`. Without one, nothing waiting is tried again, the daily check never runs, and **Kindgi → Settings** shows next tries in the past.
- **Deactivating the plugin stops all of this.** Pause the site in Kindgi if the plugin stays off.

## Security: what "the site vouches" means

A site's statements are exactly as strong as the site's own login, and as whoever can run code on it: its administrators, its plugins and themes, its host. Anyone who can make the site sign can act as any of its people, but only inside the site's one project and under its reviewer ceiling.

- **Four eyes inside one site is one administrator's word.** Someone who controls the site can vouch for two people.
  - **Where four eyes must be real:** give the tool a required reviewer role above the site's ceiling, so that a person signed in to Kindgi directly decides.
  - **For a tool that acts outside the store** (email to customers, a payment provider, a CRM): set its required role above the site's ceiling. Approving it from the site would give whoever controls the site reach the store alone doesn't have.
- **Pausing the site in Kindgi** ends every session it opened, and so does revoking its key. Connecting again ends them too.
- **The cached sessions:** the plugin caches each person's session for up to 15 minutes, sealed.
  - With the signing key in `wp-config.php` or the environment, the seal's key is made from it, so reading the database alone opens no session.
  - With the key in the database, a copy of the database carries the key itself, and the sessions with it. That's one more reason to keep the key in `wp-config.php`.

## When WooCommerce turns off a webhook to Kindgi

WooCommerce turns a webhook off after 7 refused deliveries in a row (its `woocommerce_max_webhook_delivery_failures` filter, 5, is checked before the count goes up), and never resends a delivery. Where Kindgi limits webhook receives (Kindgi hosted does), it answers a delivery past the limit with 429 and `Retry-After`, which WooCommerce counts as a refusal like any other. So a webhook to Kindgi's receive URL (`/v1/hooks/<tenant id>/<webhook id>`, at any address) can stop after a burst.

**Kindgi → Settings** lists the ones WooCommerce turned off, with when (from WooCommerce's `woocommerce_webhook_disabled_due_delivery_failures`), a link to each, and **Turn it on again** for someone with `manage_woocommerce`. That sets it active with its refusals counted from 0. Turned on in WooCommerce's own webhook screen instead, it keeps its refusal count until a delivery gets through, so a refusal before then turns it off again. Orders from while it was off aren't resent.

## Store actions as an agent's tools

To give an agent tools that act on the store (look up an order, refund it), WordPress's Abilities API and the MCP Adapter can expose them over MCP:

- **Register your own MCP server with the adapter** and list each ability as its own tool. With its endpoint registered in Kindgi as `shop`, the ability `acme/refund-order` is the tool `shop.acme-refund-order`, and can require approval alone.
- **Don't expose the default server's `execute-ability` tool.** It runs any ability by name, so one approval rule would cover every action.
- **Set `meta.mcp.public` to `false`** on every ability with side effects. The default server then never exposes it, even when the ability is otherwise public, and only your own server does.
- **Give money-moving tools no automatic retries on a tool error.** A retry is a new call, with its own approval and its own idempotency key. If the first call refunded before it failed, the retry refunds again.

## What the plugin stores

| What | Where |
|---|---|
| Kindgi's URL | The `kindgi_url` option, or the `KINDGI_URL` constant |
| The enrollment: the site's id, Kindgi's audience, the key's id, the origin | The `kindgi_site` option |
| The signing key, when it isn't in `wp-config.php` or the environment | The `kindgi_site_secret_key` option, not autoloaded |
| Each person's subject, Kindgi id, and sealed session | User options `kindgi_subject`, `kindgi_user_id`, `kindgi_session` |
| The people Kindgi knows (subject, user id, roles), and changes still waiting to reach it | The `kindgi_people` option, not autoloaded |
| When WooCommerce turned off each webhook to Kindgi | The `kindgi_webhooks_disabled_at` option, not autoloaded |

WordPress's personal-data tools (**Tools → Export Personal Data** and **Erase Personal Data**) cover each person's subject and Kindgi id. Erasing forgets the person on this site, and tells Kindgi they left, which ends their access there for good. Kindgi keeps its own record of the person, and their name stays on the records they're part of, decisions included.

Deleting the plugin removes all of them except each person's subject and Kindgi id, and the people Kindgi knows. They say who each person is, so a site installed again and connected with a new code for the same site in Kindgi finds the same people there, with their history, and tells Kindgi any change still waiting. Kindgi keeps its own record.

## Contributing

- **The licence is Apache-2.0,** like the rest of this repository. Every PHP file starts with its SPDX header and the Kindgi copyright line (`pnpm run check:headers`).
- **Never copy GPL code into this plugin.**
  - That means no WordPress core snippets and no code from GPL plugins or libraries.
  - Call WordPress's APIs instead. Calling them is fine; copying their code isn't.
- **Plain PHP, no Composer dependencies.** HTTP goes through `wp_remote_request`, and signing uses libsodium.
- **Tests** need no WordPress:

  ```sh
  php tests/run.php                   # the plugin's classes, against small stand-ins
  node --test tests/statement.test.mjs # a statement the plugin signs verifies as Kindgi checks it
  ```
