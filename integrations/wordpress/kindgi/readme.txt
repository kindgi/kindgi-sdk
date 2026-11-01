=== Kindgi ===
Contributors: <wordpress-org-username>
Tags: ai, agents, approvals, woocommerce, staff
Tested up to: 7.1
Stable tag: 0.1.0
License: Apache-2.0
License URI: https://www.apache.org/licenses/LICENSE-2.0

Your store's staff ask your Kindgi agents and approve what they're about to do, in wp-admin, each as themselves.

== Description ==

This plugin brings your store's staff to your Kindgi agents. In wp-admin, each person signed in to WordPress can:

* **ask** the project's agents, in conversations of their own;
* **approve or reject** what an agent is about to do, for example a refund, when the action needs a person.

Each person acts as themselves. Kindgi's record says "approved by Jane, via Acme store", never "approved by the store".

= How it works =

* **The site vouches for its staff.** When Jane opens a Kindgi page, the plugin signs a short statement, "the person signed in here is Jane, with these WordPress roles", and sends it to Kindgi, server to server. Kindgi exchanges it for a 15-minute session as Jane, limited to the site's project. What she can do there comes from her roles on this site, under the ceiling the site was registered with.
* **Nothing reaches the browser but this site's own pages.** The page calls the plugin's routes (`/wp-json/kindgi/v1/…`), and the plugin calls Kindgi. No Kindgi token is ever in a browser.
* **People are matched by the site, never by email.** Each person is a random id the plugin keeps for them, never their WordPress user id, login name or email.

= What you need =

* **Kindgi with site sign-in on.** Kindgi Cloud's is coming. A Kindgi server you run needs it turned on: see [the WordPress page of Kindgi's docs](https://docs.kindgi.com/sites/wordpress/).
* **PHP with sodium.** WordPress ships a fallback for PHP builds without ext/sodium.

== Installation ==

1. Install the plugin from **Plugins → Add Plugin** (search for Kindgi), and activate it.
2. Under **Kindgi → Settings**, read the site's two addresses: its origin, and its approvals URL.
3. Register the site in Kindgi, on the project its staff will use. A tenant admin does this, with the Kindgi CLI's `kindgi sites register`, which prints a one-time code good for 15 minutes. [The WordPress page of Kindgi's docs](https://docs.kindgi.com/sites/wordpress/) has the command.
4. Under **Kindgi → Settings**, paste the one-time code and the Kindgi URL this server reaches (`https://platform.kindgi.com` on Kindgi Cloud), and connect. Your staff can use the **Kindgi** page from then on.

The URL must be `https://`. An `http://` URL works only to this computer (`localhost`) or from a local or development site (`WP_ENVIRONMENT_TYPE`).

== Frequently Asked Questions ==

= Does the plugin send anything before it's connected? =

No. It sends nothing until an administrator enters a Kindgi URL under **Kindgi → Settings** and connects with a one-time code from Kindgi. Activating the plugin sends nothing.

= Who sees the Kindgi pages? =

With WooCommerce active, people who can manage WooCommerce: shop managers and administrators. Without it, people who can edit others' posts: editors and administrators. Authors, contributors and customers never see them. The `kindgi_capability` filter changes it. Kindgi decides the rest from the person's roles on this site.

= Where should the signing key live? =

In `wp-config.php`, set before connecting:

`define( 'KINDGI_SITE_SECRET_KEY', '…' );`

`php -r 'echo base64_encode(random_bytes(32)), PHP_EOL;'` makes one. An environment variable of the same name works too. A copy of the database, such as a backup or a staging clone, never carries `wp-config.php` or the environment. Without one, the plugin keeps the key it makes in a database option that isn't autoloaded.

= Can the plugin send no email addresses? =

Yes. Each statement carries the person's email, for Kindgi's "an approval is waiting" mail only. Return `''` from the `kindgi_statement_email` filter to send none, or another address to send that one.

= What happens when someone leaves? =

Kindgi is told, for good. Deleting their user, removing them from the site on a network, or erasing their data under **Tools → Erase Personal Data** ends their grants, reviewer role and sessions at Kindgi, and Kindgi refuses them from then on. Kindgi keeps its own record of the person, and their name stays on the records they're part of, decisions included.

= What does deleting the plugin remove? =

The Kindgi URL, the connection, the signing key it made, each person's cached session, its scheduled runs, and its record of when WooCommerce turned off each webhook to Kindgi. Each person's random id and Kindgi id stay, and so does the list of people Kindgi knows, with any change still waiting to reach Kindgi. They say who each person is, so the plugin installed again and connected with a new code for the same site in Kindgi finds the same people there, with their history. While the plugin is active, erasing a person's data under **Tools → Erase Personal Data** removes their ids here, and tells Kindgi they left.

= Does it need wp-cron? =

Yes. A change that can't reach Kindgi waits, and WordPress tries it again on its own. Once a day the plugin also checks everyone Kindgi knows against WordPress. On a site with `DISABLE_WP_CRON` set, a system cron must call `wp-cron.php`.

== External services ==

This plugin connects the site to Kindgi, which runs the AI agents the site's staff ask and approve. Kindgi is either Kindgi Cloud, run by Kindgi Inc., or a Kindgi server the site's owner runs. The plugin sends only to the Kindgi URL an administrator enters, and nothing before they connect.

= What the plugin sends, and when =

* **When an administrator connects:** the one-time code from Kindgi, and the public half of the site's signing key.
* **When a staff member opens a Kindgi page with no live session** (a session lasts 15 minutes): a statement the site signs, with the site's id, a random id for the person, their display name, their WordPress roles, and their email address. Kindgi uses the email only to mail them when an approval waits for them; the `kindgi_statement_email` filter sends none.
* **While they use the page:** their messages to agents and their approval decisions, and the requests that read their conversations and approvals.
* **In the background:** a statement when someone's roles change, when someone is deleted or removed from the site, again when one didn't get through, and on a daily check. These go only for people Kindgi already knows.

Kindgi uses this so each person asks and approves as themselves, with what their roles on the site allow. Each request also carries the site's address and its WordPress version, which WordPress sends with every request it makes.

= Store data that reaches Kindgi outside this plugin =

This plugin doesn't send orders or customer records. A store can send them to Kindgi in two ways, each set up by the store's own staff outside this plugin:

* **WooCommerce webhooks.** A webhook added in WooCommerce → Settings → Advanced → Webhooks with a Kindgi receive URL sends Kindgi each event of its topic. For orders and customers, the event carries the record as WooCommerce's REST API returns it. An order holds the customer's name, email address, phone number, billing and shipping addresses, the items bought, any note left at checkout, and the IP address and browser the order was placed from.
* **Store tools for agents.** Abilities the store exposes through WordPress's Abilities API and the MCP Adapter, and registers in Kindgi, can be called by the store's agents. Kindgi receives what each call returns, for example an order an agent looked up.

Staff may also mention a customer in a message to an agent. That message goes to Kindgi like any other.

When WooCommerce turns off a webhook to Kindgi after refused deliveries, **Kindgi → Settings** lists it for the site's administrators, and **Turn it on again**, for one who can also manage WooCommerce, restarts its deliveries. Events from while it was off aren't resent.

The agents send what they work on to the AI model provider they're set up with, and to the tools they call.

With Kindgi Cloud, Kindgi Inc. processes this data for the store, only to run the store's agents: see the [Kindgi Cloud terms](<terms URL>) and the [privacy policy](<privacy URL>). With a Kindgi server the site's owner runs, the data goes to that server.

== Changelog ==

= 0.1.0 =

* The first version: a site's staff ask a project's agents, and approve or reject what an agent is about to do, each as themselves.
