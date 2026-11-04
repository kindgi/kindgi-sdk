---
title: Use Kindgi from Claude
description: Add your company's Kindgi to claude.ai, sign in as yourself, and run your agents from a chat. Follow long runs in Kindgi's own view, and disconnect any time.
sidebar:
  order: 0
  label: Use Kindgi from Claude
---

Add Kindgi to claude.ai, and you can ask Claude to run the agents your
builders offer in chat, follow each run to its end, and get its answer in the
chat. Claude acts as you: it sees only what you can see in Kindgi, and it
can't change agents, settings or other people's work.

## Before you start

- **Your Kindgi's chat address,** which ends in `/mcp`, for example
  `https://kindgi.example.com/mcp`. Your Kindgi admin gives it to you
  ([Let people use Kindgi from Claude](../../deploy/self-hosted/chat-apps/)).
- **A claude.ai account** that can add custom connectors.
- **Your Kindgi sign-in,** the one you use for the console. A chat app can't
  use an API key's sign-in, so if you open the console with an API key,
  sign in as yourself for this.

## Add Kindgi to claude.ai

1. In claude.ai, open **Settings → Connectors** and choose **Add custom
   connector**.
2. Name it, for example Kindgi, enter the chat address, and save.
3. Choose **Connect**. A tab opens Kindgi. If you aren't signed in there,
   sign in as you do for the console.
4. Read the consent page, then choose **Allow**:
   - Its title, **A chat app wants to use Kindgi as** …, names you and your
     workspace.
   - Under it, **You'll go back to claude.ai** shows where the tab goes
     next, in large text. If it names anything other than `claude.ai`,
     choose **Cancel**.
   - Two permissions, both ticked. Untick one if you don't want Claude to
     have it:
     - **Follow your runs and see their results**
     - **Run the agents and flows you're allowed to run, and follow their
       runs**

   The request lasts five minutes. If the page says it expired, start again
   from claude.ai.
5. The tab goes back to claude.ai, and the connector shows as connected.

If your Kindgi doesn't check permissions per project, anyone signed in can
see and run every agent there, and Claude gets the same access.

claude.ai may ask you before it uses a Kindgi tool, with **Always allow** for
that tool. That choice belongs to this connector: if you remove the connector
and add it again, claude.ai asks again.

## What you can ask

- **Run an agent or flow:** each one its builder offers in chat that you can
  see in Kindgi is a tool Claude can call with your message. Claude can also
  go on with an agent's earlier conversation. If you can see one but can't
  run it, Claude tells you so: ask a project admin.
- **Follow a run:** a run that isn't done within about 25 seconds comes back
  with its link and Kindgi's own view of the run, right in the chat. The view
  follows the run to its end. It shows what the run waits for while it waits,
  and its answer and the names of its files when it ends. Claude waits for it
  too, with `kindgi.run_state`, and answers when it ends.
- **Waits:** when a run waits for someone, Claude says what it waits for and
  gives its link. You decide in Kindgi.

Only agents and flows their builders offer in chat show up there. If you're
missing one, ask its builder.

## What stays in Kindgi

- **Deciding a wait.** Approving or declining happens in the console.
- **Changing things.** Claude can't change agents, settings or other people's
  work. Even if you're an admin in Kindgi, Claude only starts runs as you and
  follows them.
- **A run's files.** Claude gets their names. Open them from the run's link.

Anything these agents return may appear in your Claude chat.

## Disconnect

In the console, open **My access**, then its **Chat apps** page. Each chat
app shows by the address it goes back to, so Claude shows as `claude.ai`.
Choose **Disconnect** next to it, then **Disconnect it**.

Claude stops acting for you at once: its next request to Kindgi is refused,
and it can't sign in again on its own. To use it again, connect it from
claude.ai.

Removing the connector in claude.ai doesn't end what you allowed in Kindgi,
so disconnect in Kindgi too.

<!-- To confirm: the Chat apps page's words and its Disconnect button, once they're in a build. -->
