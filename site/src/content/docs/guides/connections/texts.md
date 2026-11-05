---
title: Texts
description: Connect your business's WhatsApp number through your own Telnyx account, and start a run of an agent for each text to it, which answers or hands the conversation to a person.
sidebar:
  order: 27
  label: Texts
---

When you finish this page, an agent answers the people who text your
business on WhatsApp. Each text starts a run, and the agent can reply on
the same number or hand the conversation to a person. A tenant admin
connects the company's number once, through the business's own Telnyx
account. Kindgi bills nothing for texts: Telnyx and Meta charge the
business for them.

In this release (runtime 0.7.0 or later), the number answers WhatsApp,
whether it's a new number or the one the business already uses in the
WhatsApp Business app. On SMS, the number keeps opt-outs (STOP and START,
[Opt-outs](#opt-outs)), but no run answers an SMS yet.

## Before you start

- **You're an admin of the workspace.** Connecting the number takes a
  tenant admin, and a trigger on it takes `admin` on its project.
- **The runtime's public address is set** (`KINDGI_PUBLIC_URL`) and
  reachable from the internet over HTTPS: Telnyx sends each text there.
- **A Telnyx account** for the business, with the WhatsApp number on it
  ([step 1](#1-put-the-whatsapp-number-on-telnyx)).
- **An agent to run,** registered on your runtime. This page runs the
  agent `acme.front-desk`.
- **The `kindgi` CLI reaches your runtime as you,** with the runtime's address
  exported as `KINDGI_API_URL` and your API key as `KINDGI_API_TOKEN`
  ([People and keys](../../../deploy/people-and-keys/#api-keys)). The
  CLI runs from any folder as `npx --yes @kindgi/cli@0.4`
  ([Install](../../../start/install/)); the trigger commands run in your
  pack's directory, as `pnpm exec kindgi`.

## 1. Put the WhatsApp number on Telnyx

In the Telnyx Portal, open **Messaging Suite → WhatsApp Messaging** and
start Embedded Signup, which takes you through Meta's steps
([Telnyx: Embedded Signup](https://developers.telnyx.com/docs/messaging/whatsapp/embedded-signup)).
For a number that isn't in the WhatsApp Business app, the standard signup
is enough, such as from **Add Number** on the **WhatsApp Numbers** tab.

### A number already in the WhatsApp Business app

The business can keep the number its customers already text. The phone
app and Kindgi then share it, which Telnyx calls coexistence
([Telnyx: WhatsApp Coexistence](https://developers.telnyx.com/docs/messaging/whatsapp/coexistence)):

1. Update the WhatsApp Business app to version 2.24.17 or later.
2. In **Messaging Suite → WhatsApp Messaging**, tick **Enable WhatsApp
   Business App coexistence** before you start Embedded Signup, from
   **Add Account** or **Connect WhatsApp Business**. **Add Number**
   doesn't support it.
3. In Meta's steps, choose to connect an existing WhatsApp Business app,
   and sync the app within 24 hours of finishing them.

Before you do, know what the phone app loses while the number is shared:

- Group chats go on in the app, but aren't synced.
- Broadcast lists become read-only, and no new ones can be made.
- Disappearing messages, view-once messages and live location are off.
- Companion devices that are linked now are unlinked.

The app's past chats don't come to Kindgi: each person's conversation
with the agent starts with the first text after you connect.

When you answer someone by hand in the phone app, the agent stops
answering that person for 24 hours after your last message
([When a person has the conversation](#when-a-person-has-the-conversation)).

## 2. Store the API key

In the Telnyx Portal, open **API Keys** and choose **Create API Key**
([Telnyx: Create API keys](https://developers.telnyx.com/docs/development/api-fundamentals/create-api-keys)).
The key goes into Kindgi's secret store under a name, never into a
registration or a chat:

```sh
npx --yes @kindgi/cli@0.4 secrets set ACME_TELNYX_API_KEY --env=production --scope=tenant
```

- `ACME_TELNYX_API_KEY` is the secret's name. The registration keeps only
  this name.
- `--env` is the runtime's environment, its `KINDGI_ENV`.
- `--scope=tenant` stores the secret for the whole workspace.

The command asks for the value twice, and doesn't show what you type.

The key reaches the whole Telnyx account, so only this registration may
use it: no tool, endpoint, webhook trigger, model provider or other
registration may name the same secret, and a pack's own code never gets
it.

## 3. Register the account

Telnyx signs each text it sends to Kindgi, and Kindgi checks the signature
with the account's public key. In the Telnyx Portal, find it under **Keys
& Credentials → Public Key**
([Telnyx: Receiving webhooks](https://developers.telnyx.com/docs/messaging/messages/receiving-webhooks)).
It isn't a secret.

```sh
npx --yes @kindgi/cli@0.4 connection-apps add texts --provider=telnyx --api-key-ref=production/ACME_TELNYX_API_KEY --public-key=<public-key>
```

- `--api-key-ref` is the environment and name you stored the key under.
- `--public-key` is the key from the Portal, which Kindgi takes as base64
  of 32 bytes. Anything else is refused, naming the field, so a pasting
  slip shows here rather than as texts that never arrive.
- `--projects=<project-id>,…` lets only those projects' runs use it.

The command prints the registration as JSON, with its `id`.

## 4. Connect the number

```sh
npx --yes @kindgi/cli@0.4 connections connect texts --for-company --number=+15551234567 --permissions=texts.reply
```

- `--number` is the WhatsApp number, in E.164.
- `--permissions=texts.reply` lets runs answer the people who text the
  number. `texts.send`, texting people who didn't text first, isn't used
  by any tool yet.

There's no sign-in page: the number is connected at once, and the
command prints the connection. Its name is the number, such as
`+15551234567`, unless you give `--label`.

Connecting moves the number onto a messaging profile that Kindgi makes in
your Telnyx account for this registration, the first time you connect a
number through it. The profile's webhook is the runtime's address, so the
number's texts come to Kindgi, and the profile's outbound settings then
apply to the number. Kindgi's profile allows every destination country and
sets no daily spend limit, since an agent answers whoever texted. You can
change both on that profile in the Portal, and Kindgi doesn't set them
back.

Connect refuses in two cases:

- **The number's texts go somewhere else today** (`inbound-in-use`): it's
  on another messaging profile of yours. The refusal names that profile's
  webhook host, or the profile when it has no webhook. Run the command
  again with `--replace-inbound` to move it anyway. Disconnecting later
  puts it back on that profile.
- **The number is connected somewhere else** (`number-in-use`): through
  another registration, or in another environment. A number answers in
  one place, so remove that connection first.

From your app, `connections.connect` takes
`{ app: 'texts', for: 'company', permissions: ['texts.reply'], number, replaceInbound? }`,
and answers `connected`, with the `connectionId`.

## 5. Answer its texts

A **text trigger** starts a run for each text to the number:

```sh
pnpm exec kindgi text-triggers create --agent=acme.front-desk --connection=+15551234567 --label="whatsapp"
```

- **What it runs:** `--agent` runs the agent's pinned version, or else its
  latest. `--agent-version` pins one. `--flow` runs a flow, and needs
  `--flow-version`. Each run's input is the text that started it.
- **Which number:** `--connection` is the company's connection of the
  number, by id or name. One trigger answers a number: a second one on it
  is refused (`trigger-connection-taken`), even while the first is paused.
- **How many:** `--runs-per-hour` is the most runs its texts start in an
  hour, 1 to 600. The default is 60. `--per-sender-per-hour` is the most
  for one person, 1 to 60. The default is 10, so one person can't run up
  the business's bill. A text past either is refused and never runs.
- **Where:** `--project=<project-id>` is its project. Without it, it's the
  workspace's default project.
- **Whose runs:** its runs act as you, with your connections. `--run-as`
  names a service account, or `project` for the project's own.
- **`--allow-unattended=<tool-id>`** names a tool whose calls in its runs
  needn't wait for a person's yes, once for each tool
  ([What waits for a yes](#what-waits-for-a-yes)).

It prints the trigger, with its `id`.

From your app, the clients have the same calls on `textTriggers`:
`register`, `list`, `get`, `update`, `pause`, `resume`, `fires`,
`versions`, `getVersion`, `takeOwnership` and `unregister`
(`text_triggers` and `take_ownership` in Python). The request's `config`
holds `connectionId`, `runsPerHour` and `perSenderPerHour`.

## What a run gets

**An agent** reads the text as data, not instructions: anyone can text the
number. A photo, a voice note or other media becomes one line saying what
was sent, since the agent can't open it.

**Each person has one conversation on each channel.** Their texts run one
at a time, in the order they came, and each later text's turn goes into the
same [conversation](../../agents/conversations/) while it's open, with
the same agent. Once the conversation is closed, or the trigger runs
another agent, the next text starts a new one.

**A flow** gets `{ text, thread }`. `text` is
`{ from, channel, body, receivedAt }`, with `channel` `whatsapp` or `sms`,
and `thread` is `{ connectionId, channel, sender }`. Its agent steps
answer: each gets the two tools below, which a tool step can't name.

## Answering

In a run a text started, the agent gets two tools built into Kindgi. It
doesn't list them in its `tools`:

- **`kindgi_reply_to_text`** answers the person who texted, on the number
  and channel they texted. The agent gives only the reply's text, up to
  1600 characters: the number and the person come from the run, never from
  the model. It's offered when the number grants `texts.reply`.
- **`kindgi_hand_to_person`** hands the conversation to a person, with a
  note for them, up to 500 characters: why, and what they need to know.

Meta asks for a clear way to reach a person. Say in the agent's
instructions when to hand over, and who answers then.

When a reply can't go out, nothing is sent, and the agent reads why as
the tool's result, so it can carry on:

- `texts-window-closed`: on WhatsApp, more than 24 hours have passed since
  the person last texted. Nothing can be sent until they text again.
- `texts-opted-out`: the person opted out of texts from this number on
  this channel.
- `texts-with-person`: a person has the conversation now.
- `texts-not-granted`: the number's connection doesn't grant
  `texts.reply`.

A step that runs again, resumed or retried, sends its reply and its
hand-over once.

## What waits for a yes

Anyone can text the number. So in a run a text started, every call that
changes something, except handing the conversation to a person, waits for
a person's yes, with the reason `text-change`
([When no person started the run](../../approvals/ask-before-a-tool-runs/#when-no-person-started-the-run)).
That includes the reply: by default, someone approves each one before it
goes out.

To let the agent answer at once, a project admin lists the reply on the
trigger:

```sh
pnpm exec kindgi text-triggers update <trigger-id> --allow-unattended=kindgi_reply_to_text
```

A workspace rule or an agent's rule that always asks still asks.
`kindgi_send_text`, a text that isn't a reply, can't be listed: it always
waits.

A reply that waited goes, once approved, to the conversation its text came
from. If a person took the conversation meanwhile, it's refused with
`texts-with-person`, and nothing is sent.

## When a person has the conversation

After `kindgi_hand_to_person`, no run starts for that person's texts.
Their new texts go into the conversation, with no run, for a person.

On a number shared with the WhatsApp Business app, answering someone by
hand in the app does the same for 24 hours after your last message. After
that, their next text starts a run again. A hand-over has no end, and a
message from the app doesn't shorten it. Telnyx passes on what you send
from the app as best it can, not as a complete record, so a message it
doesn't pass on doesn't stop the agent.

## Opt-outs

An SMS that says STOP, or one of its usual synonyms, opts the person out of
texts from that number on SMS, and START opts them back in. Kindgi keeps
these even while nothing answers the number, and a text to someone who
opted out on that channel is refused with `texts-opted-out`. On WhatsApp,
STOP is an ordinary text, which the agent reads.

The opt-out list keeps the business's number, the person's number, the
channel and the time, and no text.
Erasing a person's conversations leaves it, since keeping it is what
honours their STOP.

## See what each text did

```sh
pnpm exec kindgi text-triggers fires <trigger-id>
```

lists the trigger's texts, newest first: the run each started, or why it
was skipped, refused (`over-limit:`, past `--runs-per-hour` or
`--per-sender-per-hour`) or failed.

`kindgi connections get <connection-id>` shows the number's connection,
with:

- `lastProvenInboundAt`: when a text last came in with a good signature.
  If texts stop arriving, check the public key in the registration.
- `textsThisMonth`: `received`, `sent` and `unanswered`, the texts with
  nothing to answer them. Those are texts that came in while the number
  had no trigger or a paused one or needed reconnecting, over a limit, or
  from someone who opted out, and SMS in this release.

## Pause it, change it

`kindgi text-triggers pause <trigger-id>` stops it answering: a text that
comes in while it's paused never starts a run. `resume` starts it again.
`update` changes what it runs, the number, its limits, its label or what
it may call unattended, and keeps its owner. `unregister` removes it.

## Disconnecting

```sh
npx --yes @kindgi/cli@0.4 connections disconnect <connection-id>
```

The number goes back on the messaging profile it was on before you
connected it, or comes off Kindgi's profile when it had none. Then
Kindgi destroys what it kept for the connection. Its trigger answers
nothing from then on.

If the number can't be moved back, such as while Telnyx is down or the key
is refused, the connection stays removing, and the command says so.
Run it again to retry. If you've already moved the number in the Portal
yourself, add `--skip-inbound-restore`. While it's removing, no run
starts for its texts, and opt-outs are still kept.

The conversations and the opt-outs stay after a disconnect.

## When the key stops working

If Telnyx refuses the key, such as after it's deleted in the Portal, the
connection needs reconnecting, with the reason `credential-refused`.
Until it's reconnected, its texts start no run and count as unanswered,
and opt-outs are still kept. Store a working key in the same secret, as a
new version of it, then connect again:

```sh
npx --yes @kindgi/cli@0.4 secrets set ACME_TELNYX_API_KEY --env=production --scope=tenant --write-mode=add-version
npx --yes @kindgi/cli@0.4 connections connect texts --for-company --reconnect=+15551234567 --number=+15551234567 --permissions=texts.reply
```

`--reconnect` names the connection by its id or its name: the number,
unless you gave `--label` when you connected.

To change the key without a gap, create the new key in the Portal, store
it in the secret right away, and only then delete the old one.

## Limits

- **Meta's:** a number shared with the WhatsApp Business app sends at
  most 20 messages a second through Kindgi.
- **The trigger's:** `--runs-per-hour` and `--per-sender-per-hour`.
- **A reply** is at most 1600 characters, and a hand-over's note 500.

## Costs

Kindgi bills nothing for texts. Telnyx and Meta charge the business.
Meta charges for templates, by their category and the
recipient's country, and not for a reply inside the 24 hours after the
person's last text
([Meta: Pricing](https://developers.facebook.com/docs/whatsapp/pricing)).
`textsThisMonth` on the connection shows how many went each way.

## Next

- [Start runs from new mail](../../runs/start-runs-from-new-mail/): the
  same for a mailbox.
- [Ask before a tool runs](../../approvals/ask-before-a-tool-runs/): how a
  person approves a call that waits.
- [How connections work](../reference/): registrations, owners and
  removal.
