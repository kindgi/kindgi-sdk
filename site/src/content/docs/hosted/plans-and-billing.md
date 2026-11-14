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
and it can't end your subscription: only the workspace's billing page does
those.

## The billing contact

The billing contact is who Stripe sends your workspace's invoices to: a
name and an email. It needn't be an admin; it can be your accounts team's
address. At sign-up it's filled in with yours: change it on the form then,
or later on the billing page
([Change the billing contact](#change-the-billing-contact)).

Besides the invoices, the billing contact gets:

- **The email if the workspace is suspended,** for invoices that weren't
  paid.
- **The emails if the workspace is closed:** when it's closed, and once
  it's deleted, after the 30 days to export it
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
  once it has the change."
- "The billing contact is saved." The name changed, and the email didn't.
- "Nothing changed: that's already the billing contact."
- "Stripe didn't take the new billing contact, so the invoices may still go
  to the address before. Save it again."

When the email changes, the address before gets one email, "Your Kindgi
workspace's billing contact changed", so a change nobody asked for doesn't
go unseen.

## Stop paying

To stop paying, choose **Stop paying** on the billing page. The plan runs
to the end of the month you've paid for, and then ends:

- **Nothing is credited or refunded** for the rest of that month, whatever
  the reason.
- **Until that day, the plan works as before,** and what's in production
  stays there. **Keep my plan**, on the billing page, takes the stop back,
  and the plan renews as before. While the stop stands, the billing page
  makes no other change to the plan.
- **From that day, nothing in the workspace runs:** no build and no run,
  in testing or live. The workspace stays, with its data: you can still
  sign in, and read and [export your data](../export-your-data/). Choose a
  plan on the billing page to run again.

A plan that ends outside Kindgi, not by a stop from the billing page or by
a close (for example, one cancelled on Stripe's side), also runs to the end
of the month you've paid for, with no credit or refund. From the day it
ends, the workspace is as after a stop.

To end the workspace as well, [close it](../close-your-workspace/).

## Next

- [Close your workspace](../close-your-workspace/)
- [Limits](../limits/): the limits every workspace has, on every plan.
