---
title: Enterprise sign-in options
description: Roles from your identity provider's groups, SCIM provisioning, agents that act for each person, and CLI sign-in through your identity provider, built with you for enterprise plans.
sidebar:
  order: 90
---

Four sign-in options go further than the identity-provider sign-in any
deployment can turn on. Each is available for enterprise plans, built with you for
your identity provider and your rules. Each section says what the option is,
then how we build it: the safe choices it starts from.

## Map your identity provider's groups to Kindgi roles

*Available for enterprise plans, built with you.*

Your identity provider already knows who's in which team. Kindgi can give
roles from those groups, so a person's access follows their team without an
admin changing it by hand.

**How we build it:**

- **Your admin maps each group to a role.** A group with no mapping gives no
  role.
- **Admin is never granted by a group** unless you turn that on explicitly.
  At least one admin is always named by a person.
- **Groups are read at every sign-in:** someone removed from a group loses
  its role the next time they sign in, or at once with SCIM (below).
- **Groups are matched by the identity provider's stable id,** not their
  display name, so renaming a group changes nothing.
- **Every role a group gives or takes away is audited,** naming the group.

## Automatic provisioning with SCIM

*Available for enterprise plans, built with you.*

SCIM lets your identity provider (Okta, Microsoft Entra ID, OneLogin…) add,
change and remove people in Kindgi by itself. When someone leaves your
company, they leave Kindgi in the same step.

**How we build it:**

- **Standard SCIM 2.0** (users and groups), so your identity provider's
  built-in SCIM connector works.
- **A provisioning-only credential,** separate from every other key,
  rotatable, and kept in your identity provider.
- **Removing a person ends their sessions at once,** and they can't sign in
  again.
- **SCIM never deletes work:** what a removed person made stays with your
  workspace, under your retention policy. Erasing a person's data is a
  separate, deliberate step: an erasure request.
- **People are matched by the identity provider's stable id,** not by email,
  so an email change doesn't create a new person.

## Agents that act as the end user

*Available for enterprise plans, built with you.*

Some agents need to work with a person's own accounts: reading their files,
say, or sending from their mailbox. Each person connects their own account,
and the agent acts for them, and only for them.

**How we build it:**

- **Each person connects their own account** through that service's own
  consent screen, with the fewest permissions the agent needs.
- **The connection's tokens stay in your secret store,** and **the agent
  never sees them:** Kindgi attaches them to the calls the agent's tools
  make.
- **Every action is recorded** as "this agent, on behalf of this person".
- **People can disconnect at any time,** and admins can revoke for everyone.
  A removed person's connections are revoked.
- **Kindgi needs no personal data** to do this: your app identifies each
  person with its own opaque id.

## `kindgi login` with your company sign-in

*Available for enterprise plans, built with you.*

Developers sign in to the CLI the way they sign in to the console, through
your identity provider, instead of handling API keys.

**How we build it:**

- **`kindgi login` opens the browser** and goes through your identity
  provider. On a machine without a browser, it shows a short code to enter
  on another device (the standard OAuth device flow).
- **The CLI gets a short-lived token for that person,** renewed while they
  keep working: never a shared, long-lived key.
- **The CLI uses the same identity provider and the same removal as the
  console:** a removed person's CLI sign-in ends.
- **Automation (CI and scripts) keeps using API keys** tied to service
  accounts, not to people.

## Talk to us

To plan one of these for your deployment, write to contact@kindgi.com.
