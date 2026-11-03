---
title: Use Kindgi from Claude
description: Add your company's Kindgi to claude.ai, sign in as yourself, and look at, run and schedule your agents from a chat. Follow long runs in Kindgi's own view, and disconnect any time.
sidebar:
  order: 0
  label: Use Kindgi from Claude
---

Add Kindgi to claude.ai, and you can ask Claude about your agents and runs,
start the agents you're allowed to run, follow a run to its end, set up your
own schedules, and see what's waiting for you. Claude acts as you: it sees
only what you can see in Kindgi, and it can't change agents, settings or
other people's work.

## Before you start

- **Your Kindgi's chat address,** which ends in `/mcp`, for example
  `https://kindgi.example.com/mcp`. Your Kindgi admin gives it to you
  ([Let people use Kindgi from Claude](../../deploy/self-hosted/chat-apps/)).
- **A claude.ai account** that can add custom connectors.
- **Your Kindgi sign-in,** the one you use for the console.

## Add Kindgi to claude.ai

1. In claude.ai, open **Settings → Connectors** and choose **Add custom
   connector**.
2. Name it, for example Kindgi, enter the chat address, and save.
3. Choose **Connect**. A tab opens Kindgi's sign-in. Sign in as you do for
   the console.
4. Read the consent page, then choose **Allow**:
   - Its title, **A chat app wants to use Kindgi as** …, names you and your
     workspace.
   - Under it, **You'll go back to claude.ai** shows where the tab goes
     next, in large text. If it names anything other than `claude.ai`,
     choose **Cancel**.
   - Three permissions, all ticked. Untick any you don't want Claude to have:
     - **See your agents, their runs and results, your schedules and what's
       waiting for you**
     - **Run the agents you're allowed to run, and stop runs you started**
     - **Create, pause and remove your own schedules**

   The page lasts five minutes. If it says the request expired, start again
   from claude.ai.
5. The tab goes back to claude.ai, and the connector shows as connected.

<!-- To confirm: whether the consent page says when the runtime doesn't check permissions per project (anyone signed in can see and run every agent, and Claude gets the same access). If so, a bullet in step 4. -->

If your Kindgi doesn't check permissions per project, anyone signed in can
see and run every agent there, and Claude gets the same access.

claude.ai may ask you before it uses a Kindgi tool, with **Always allow** for
that tool. That choice belongs to this connector: if you remove the connector
and add it again, claude.ai asks again.

## What you can ask

- **Look:** your agents, your runs and others you can see, a run's answer and
  files, your schedules, and what's waiting for you.
- **Run an agent:** each agent you may run is a tool Claude can call with
  your message. A run that isn't done within about 25 seconds comes back with
  its link and Kindgi's own view of the run, right in the chat. The view
  follows the run to its end and shows its steps, waits and answer as they
  come, so you can keep chatting meanwhile. When it ends, **Put the result in
  the chat** sends the result to the conversation.
- **Stop a run** you started.
- **Schedules:** create your own ("every Monday at 9 in Berlin"), pause,
  resume and remove them, or start one now. Claude asks for your time zone
  when the chat doesn't make it clear, and shows the next times it will run
  so you can check them.
- **Waits:** Claude lists what's waiting for you, explains each one and gives
  its link. You decide in Kindgi.

Only agents their builders offer in chat show up there. If you're missing
one, ask its builder.

## What stays in Kindgi

- **Deciding a wait.** Approving or declining happens in the console.
- **Changing things.** Claude can't change agents, settings or other people's
  work. Even if you're an admin in Kindgi, Claude acts only on your own runs
  and schedules.
- **Answers and files, if your workspace turns them off.** With **Results in
  chat** off, Claude gets status and links only.

Anything these agents return may appear in your Claude chat.

## Disconnect

In the console, open **My access**. Under **Chat apps**, choose
**Disconnect** next to Claude.

<!-- To confirm: how the Chat apps list names Claude, what Disconnect ends at once, and whether removing the connector in claude.ai ends Kindgi's grant. -->
