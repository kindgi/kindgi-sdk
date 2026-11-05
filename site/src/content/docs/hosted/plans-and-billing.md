---
title: Your plan and billing
description: Who sees your Kindgi Cloud workspace's billing, the billing contact Stripe sends its invoices to, your card and invoices on Stripe, and what stopping payment does.
sidebar:
  order: 3
---

Your workspace's billing is on its billing page,
[platform.kindgi.com/cloud/account/billing](https://platform.kindgi.com/cloud/account/billing).
Payments go through Stripe.

## Who sees it

Only the workspace's admins can open the billing page. Signed out, it asks
you to sign in to the console first. Signed in as someone who isn't an
admin, it says to ask one of your admins
([Make someone a tenant admin](../../deploy/people-and-keys/#make-someone-a-tenant-admin)).

## Your card, invoices, billing address and tax ID

They're on Stripe. On the billing page, choose **Open Stripe's billing
page**. The link it opens works once, for a few minutes, so open it from
the billing page each time.

Stripe's billing page changes neither your plan nor the billing contact,
and it can't end your subscription: only your billing page does those.

## The billing contact

The billing contact is who Stripe sends your workspace's invoices to: a
name and an email. It needn't be an admin; it can be your accounts team's
address. At sign-up it's filled in with yours, and you can change it there.

Besides the invoices, the billing contact gets:

- **The email if the workspace is suspended,** for invoices that weren't
  paid or a subscription that was cancelled.
- **The emails if the workspace is closed:** when it's closed, and when
  it's deleted, 30 days on
  ([Close your workspace](../close-your-workspace/#what-closing-does)).

The billing contact can also
[ask us to close the workspace](../close-your-workspace/#ask-us-to-close-it).

### Change the billing contact

Any admin can change it, at any time:

1. On the billing page, under **Billing contact**, choose **Change the
   billing contact**.
2. Enter the name and email, and choose **Save the billing contact**.

The billing page then says where the change stands:

- "The new billing contact is saved: Stripe sends the invoices to _email_
  once it has the change." A new email takes Stripe a moment.
- "The billing contact is saved." The name changed, and the email didn't.
- "Nothing changed: that's already the billing contact."
- "Stripe didn't take the new billing contact, so the invoices may still go
  to the address before. Save it again."

When the email changes, the address before gets one email, "Your Kindgi
workspace's billing contact changed", so a change nobody asked for doesn't
go unseen.

## Stop paying

To stop paying and keep the workspace, free to build and test, end the
subscription from the billing page. It ends at once:

- **What's left of the billing month** is kept as a credit toward your next
  invoice, for when you pay again. It isn't refunded.
- **Nothing is taken out of production for you.** Stopping is refused while
  more is in production than the workspace keeps without paying: take
  projects out in the console first, then stop again.
- **The workspace stays,** with everything in it.

A subscription cancelled outside Kindgi, with projects still in
production, suspends the workspace instead: nothing in it runs, its data
is kept, and you can still read and export it. Paying again from the
billing page lifts it.

To end the workspace as well, [close it](../close-your-workspace/).

## Next

- [Close your workspace](../close-your-workspace/)
- [Limits](../limits/): the limits every workspace has, on every plan.
