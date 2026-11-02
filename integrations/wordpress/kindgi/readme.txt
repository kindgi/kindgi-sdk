=== Kindgi ===
Contributors: <wordpress-org-username>
Tags: ai, agents, approvals, woocommerce, staff
Tested up to: 7.1
Stable tag: 0.2.0
License: Apache-2.0
License URI: https://www.apache.org/licenses/LICENSE-2.0

Your store's staff ask your Kindgi agents and approve what they're about to do, in wp-admin, each as themselves.

== Description ==

This plugin brings your store's staff to your Kindgi agents. In wp-admin, each person signed in to WordPress can:

* **ask** the project's agents, in conversations of their own;
* **approve or reject** what an agent is about to do, for example a refund, when the action needs a person: in the Kindgi Inbox, or on the screen of the WooCommerce order it's about;
* **see what the agents did**, on Activity and in a Kindgi box on the dashboard.

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
4. Under **Kindgi → Settings**, paste the one-time code and the Kindgi URL this server reaches (`https://platform.kindgi.com` on Kindgi Cloud), and connect. Your staff can use the **Kindgi** menu from then on: Inbox, Activity and Ask.

The URL must be `https://`. An `http://` URL works only to this computer (`localhost`) or from a local or development site (`WP_ENVIRONMENT_TYPE`).

== Frequently Asked Questions ==

= Does the plugin send anything before it's connected? =

No. It sends nothing until an administrator enters a Kindgi URL under **Kindgi → Settings** and connects with a one-time code from Kindgi. Activating the plugin sends nothing.

= Who sees the Kindgi pages? =

With WooCommerce active, people who can manage WooCommerce: shop managers and administrators. Without it, people who can edit others' posts: editors and administrators. Authors, contributors and customers never see them. The `kindgi_capability` filter changes who sees them, except **Kindgi → Settings**, which is for administrators only. The same people see the Kindgi box on the dashboard; the Kindgi box on a WooCommerce order's screen also needs the right to edit orders. Kindgi decides the rest from the person's roles on this site.

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
* **When a staff member with no live session opens a Kindgi page, or presses Show what Kindgi has in the Kindgi box on the dashboard or on an order** (a session lasts 15 minutes): a statement the site signs, with the site's id, a random id for the person, their display name, their WordPress roles, and their email address. Kindgi uses the email only to mail them when an approval waits for them; the `kindgi_statement_email` filter sends none.
* **While they use the Kindgi pages and boxes:** their messages to agents and their approval decisions, and the requests that read their conversations, the project's approvals, runs and agents, and what Kindgi lets them do.
* **In the background:** while someone with a live session is in wp-admin, a request at most once a minute for how many approvals wait for them, for the count on the **Kindgi** menu and the admin bar; it never starts a session. Also a statement when someone's roles change, when someone is deleted or removed from the site, again when one didn't get through, and on a daily check. These statements go only for people Kindgi already knows.

Kindgi uses this so each person asks and approves as themselves, with what their roles on the site allow. Each request also carries the site's address and its WordPress version, which WordPress sends with every request it makes.

= Store data that reaches Kindgi outside this plugin =

This plugin doesn't send orders or customer records. A store can send them to Kindgi in two ways, each set up by the store's own staff outside this plugin:

* **WooCommerce webhooks.** A webhook added in WooCommerce → Settings → Advanced → Webhooks with a Kindgi receive URL sends Kindgi each event of its topic. For orders and customers, the event carries the record as WooCommerce's REST API returns it. An order holds the customer's name, email address, phone number, billing and shipping addresses, the items bought, any note left at checkout, and the IP address and browser the order was placed from.
* **Store tools for agents.** Abilities the store exposes through WordPress's Abilities API and the MCP Adapter, and registers in Kindgi, can be called by the store's agents. Kindgi receives what each call returns, for example an order an agent looked up.

Staff may also mention a customer in a message to an agent. That message goes to Kindgi like any other. **Ask about this order**, in an order's Kindgi box, starts a message with the order's number ("About order #1234: "), which goes to Kindgi once they send it.

When WooCommerce turns off a webhook to Kindgi after refused deliveries, **Kindgi → Settings** lists it for the site's administrators, and **Turn it on again**, for one who can also manage WooCommerce, restarts its deliveries. Events from while it was off aren't resent.

The agents send what they work on to the AI model provider they're set up with, and to the tools they call.

With Kindgi Cloud, Kindgi Inc. processes this data for the store, only to run the store's agents: see the [Kindgi Cloud terms](<terms URL>) and the [privacy policy](<privacy URL>). With a Kindgi server the site's owner runs, the data goes to that server.

== Changelog ==

= 0.2.0 =

* **A Kindgi menu, in place of one page with two tabs.** Inbox, Activity, Ask and Settings each open with Kindgi's mark, take the person's admin color scheme, and say in staff words what's loading, what an empty list is for, and what went wrong. Kindgi's own words about an error show only to administrators.
* **The Inbox: what waits for you, and what was decided.** It lists what waits for you, what waits for someone else and why, and the project's decided approvals, whoever decided. That includes an approval assigned to you or in review, which 0.1.0 didn't list, and one that expired, was withdrawn or was passed on. A card reads in words: the tool's title or name, the call's fields, the agent's own words quoted as written, who asked and when, and what happens if no one decides in time. A mail tool's reply reads as the email it sends, and an approval about a WooCommerce order links to it for whoever may edit orders.
* **Buttons that say what each decision does.** A reply's card reads "Approve and send" and "Don't send…"; other calls keep Approve and Reject…. The box for a reason opens only on a rejection and says what it does, and once Kindgi records the decision, the card says what follows. A new version of an agent waiting to go live reads as an update, such as "Update Support desk to version 1.2.0", with "Approve the update" and "Don't update…".
* **A count of what waits for you,** on the Kindgi menu and in the admin bar, kept fresh by WordPress's heartbeat. Opening a page never signs anyone in: Kindgi is asked only while the person's session from this site lasts.
* **Activity, a feed of the project's runs by day.** Each run shows its agent, its state, who or what started it and what it answered, with the whole output a click away. Someone else's run shows as one line. A run that waits for a person names the approval it waits for, linked to its card, and every run has a link of its own.
* **Ask reads as a chat.** A new conversation is ready to type in, with the agent picker in the box, the person's conversations beside it and, on a store, three questions to start from. Only the agents an administrator offers to staff are there. The agent's paragraphs, lists, bold and code show as such, never as HTML, and a turn that fails keeps its words to send again. Mail that started a conversation reads as its email thread, with the approval the agent waits on, to decide there. Each tool the agent used is a step, and a call that didn't go through says why: it wasn't allowed, a guardrail stopped it, a reviewer rejected it, or it failed.
* **WooCommerce orders.** For someone who may use Kindgi and edit orders, an order's screen has a Kindgi box: what waits about the order, to decide there, what was decided and by whom, the agents' replies to the order's billing email, and "Ask about this order". The Orders list has a Kindgi column, "Waits for you" or "Waits for a reviewer", and each decision made on the site adds a private note to its order.
* **Kindgi on the dashboard.** A box shows how many approvals wait for you, the oldest two by name, and the latest three runs, with a box to ask that opens Ask with the question written in. Opening the dashboard signs no one in.
* **Settings at a glance.** Connected, it opens on a status card: the project by name, whether staff sign in as themselves (checked live), on a store whether its events reach Kindgi, and any changes still on their way. The agents offered to staff are rows a click ticks. Not connected yet, it's two steps: send a Kindgi administrator the site's two addresses, then paste the one-time code they send back.
* **Ask opens a conversation.** In 0.1.0, a question to one of the site's own agents was refused for everyone the site signs in. The plugin named the site's project when it opened the conversation, and naming a project needs `write` on it, which a site's people never get. Now it names no project for the site's own agents, so Kindgi opens the conversation in the agent's own project, the site's. For an agent another project shares with the site's, it names the site's project, where calling the agent is enough.
* **A saved conversation opens without "null" text, and an approval from an email shows once.** In 0.1.0, a saved conversation opened from the list, or from an approval's "Open the conversation", was headed with the text "nullnull". And an approval opened from its email link after it was decided showed twice: under "From your link", and again in "Decided by you lately". Now an approval from a link opens in the Inbox under the list that holds it ("Waits for you", "Waits for others" or "Decided"), and "From your link" shows only one that none of them holds.

= 0.1.0 =

* The first version: a site's staff ask a project's agents, and approve or reject what an agent is about to do, each as themselves.
