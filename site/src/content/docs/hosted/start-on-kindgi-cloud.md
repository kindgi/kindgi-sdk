---
title: Start on Kindgi Cloud
description: The steps from signing up for Kindgi Cloud to your first agent live, in order, each with the page that has its details.
sidebar:
  order: 0
---

This page takes you from signing up for Kindgi Cloud to your first agent
live, step by step. Each step is short and links to the page that has its
details.

## 1. Sign up

Sign up with your name, your organization's name and your work email, and
open the link the email sends you. Then give your organization's billing
details, accept the terms and the data processing addendum on its behalf,
and choose **Create the workspace**.
[Sign up for Kindgi Cloud](../sign-up/) has each step, and what happens
after you sign up.

Whoever signs up is the workspace's first admin. The steps below need an
admin.

## 2. Sign in to your workspace

Sign in to the console at
[platform.kindgi.com/console](https://platform.kindgi.com/console/). It
opens your workspace's default project, **First Project**. Every workspace
starts with it, and your first agent goes into it.

To give it your own name, choose **Rename the project** at the top of its
**Dashboard**. Its slug, the name pack configs and scripts use for it,
changes only if you ask for that too.

## 3. Write your agent on your machine

Your coding agent writes the agent with you, on your own machine, and a
Kindgi runtime there runs it while you try it:

- [Quickstart](../../start/quickstart/) goes from an empty folder to an
  agent that answers.
- [Install](../../start/install/) says what your machine needs.
- [Your coding agent](../../start/coding-agents/) says which commands it
  runs and what stays with you.

Try it there until it answers the way you want, with its tests passing.

## 4. Deploy it to Kindgi Cloud

[Deploy your agent](../deploy-your-agent/) has every command. In short:

1. **Sign the CLI in** with an Admin key you make in the console
   ([Sign the CLI in](../deploy-your-agent/#sign-the-cli-in)).
2. **Sign the pack** with a key your workspace trusts
   ([Sign the pack](../deploy-your-agent/#sign-the-pack)).
3. **Store your AI provider's key** on `prod`
   ([Your model key and its provider](../deploy-your-agent/#your-model-key-and-its-provider)).
4. **Deploy:** `kindgi deploy --hosted --env=prod`
   ([Deploy](../deploy-your-agent/#deploy)).

The deploy goes into the default project. If you made another project in
the console and want the agent there, name it:
`kindgi deploy --hosted --env=prod --project=<id-or-slug>`. Without
`--project`, the agent lands in the default project, and the other
project's **Dashboard** has nothing to run.

## 5. Try it, then go live

1. **Try it:** start a run in the console
   ([Try it](../deploy-your-agent/#try-it)).
2. **Pin the version you tried,** then **go live** from the project's
   **Dashboard** ([Go live](../deploy-your-agent/#go-live)).

How many projects can be live at once is in
[Kindgi Cloud's limits](../limits/#projects-in-production). If going live
is refused, [If something goes wrong](../deploy-your-agent/#if-something-goes-wrong)
says what to do.

## 6. Your plan and billing

[Your plan and billing](../plans-and-billing/) says who sees them, where
your card, invoices and billing address are, who the billing contact is,
and how to stop paying.

## Close your workspace

When you no longer need it, [Close your workspace](../close-your-workspace/)
says how, what closing does, and what's kept.

## Next

- [Change your agent once it's live](../deploy-your-agent/#change-your-agent-once-its-live):
  try a new version in the same project, then pin it.
- [Organize by org and project](../../guides/projects/organize-by-org-and-project/):
  a project for each client or team.
- [Kindgi Cloud's limits](../limits/): the limits every workspace has, and
  how to ask for more.
