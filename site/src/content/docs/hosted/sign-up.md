---
title: Sign up for Kindgi Cloud
description: Create a Kindgi Cloud workspace for your organization: the form, the email link, your organization's details and the terms, and signing in for the first time.
sidebar:
  order: 2
---

Signing up creates a Kindgi Cloud workspace for your organization. Whoever
signs up is its first admin. The API calls a workspace a tenant, as in
`tenantId`.

## Before you start

- **A work email address you can read now.** The link it gets works for 30
  minutes.
- **Your organization's billing details:** its legal name, its address and
  country, and its GST/HST or VAT number if it has one.

## 1. Fill in the form

At [platform.kindgi.com/cloud/signup](https://platform.kindgi.com/cloud/signup),
give your name, your work email and your organization, and choose **Email
me a link**. The form expires after an hour.

"Too many sign-ups from here" is a limit on sign-ups from one place: try
again in an hour.

## 2. Open the link

The email is "Your Kindgi sign-up link". Its link works once, within 30
minutes, and opens **Confirm your email**: choose **Continue**. The extra
step keeps a mail scanner that opens links from using it up.

A link that's been used, or is more than 30 minutes old, says "This link
can't be used": sign up again.

The sign-up page never says whether an address already has a workspace.
An address that has one, or has a sign-up waiting, gets an email saying so
instead.

## 3. Give your organization's details

- **Billing:** the organization's legal name; the billing contact and
  billing email, filled in with yours; its address and two-letter country;
  and its GST/HST or VAT number, if it has one. Stripe sends the invoices
  to the billing email
  ([The billing contact](../plans-and-billing/#the-billing-contact)).
- **The terms:** accept the Kindgi Cloud terms and the data processing
  addendum on behalf of your organization.

Then choose **Create the workspace**.

## 4. Sign in

"Setting up your workspace" moves on by itself, in a few seconds, and an
email, "_Your organization_'s Kindgi workspace is ready", follows. Choose
**Sign in**: the console opens with your email filled in.

The workspace starts with one project, First Project. A deploy goes there
unless you name another project.

If there's no room for a new workspace just then, the page says "We're
adding capacity" instead, and the email comes as soon as your workspace is
ready.

## Withdraw a sign-up

A sign-up that's still waiting can be withdrawn, from the link in the
email that says it's waiting. We don't create the workspace, and we delete
the sign-up's details within 30 days, except the terms you accepted.

Once the workspace is made, [close it](../close-your-workspace/) instead.

A sign-up whose email was never confirmed, or whose details were never
sent, is deleted 7 days after its link expired.

## Next

- [Your plan and billing](../plans-and-billing/)
