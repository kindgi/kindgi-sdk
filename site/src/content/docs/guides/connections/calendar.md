---
title: Calendars
description: Let a tool find events, see when someone is free, and add or change events on their own Google or Outlook calendar, with the least access each one needs.
sidebar:
  order: 17
  label: Calendars
---

The calendar tools work on the calendar of the account someone connected:
their own, or, with `as: 'company'`, the company's calendar that a tenant
admin connected. There are four for Google Calendar and four for Outlook.
Each one asks for the least access its call takes.

They use the same Google or Microsoft connection as the mail tools. Turn
on the calendar in your client or app first:
[Google](../google/#1-create-the-client-in-the-google-cloud-console), step 1,
or [Microsoft](../microsoft/#2-register-the-app-in-microsoft-entra), step 3.

## The tools

| What it does | Google | Outlook | What it asks for |
| --- | --- | --- | --- |
| Lists the events in a window | `googleCalendarEventsList` | `outlookCalendarEventsList` | Google: see the events on your calendars. Outlook: see your calendar's events, without their details. |
| Says when the calendar is busy | `googleCalendarFreeBusy` | `outlookCalendarFreeBusy` | Google: see when you're free or busy. Outlook: the same as a list. |
| Adds an event | `googleCalendarEventCreate` | `outlookCalendarEventCreate` | Add and change events (Google), or read, add and change them (Outlook). |
| Changes an event | `googleCalendarEventUpdate` | `outlookCalendarEventUpdate` | The same as adding one. |

Google's are in `@kindgi/connections/google/tools`, and Outlook's are in
`@kindgi/connections/microsoft/tools`. A pack includes one as it includes a
mail tool, as a tool folder whose `index.ts` names its id:

```ts excerpt
import { googleCalendarEventCreate } from '@kindgi/connections/google/tools';

export default googleCalendarEventCreate({ id: 'acme.calendar.create' });
```

For the company's calendar, give the tool its own id, since `as` is part of
what the tool declares:

```ts excerpt
export default googleCalendarEventCreate({ id: 'acme.store-calendar.create', as: 'company' });
```

A list gives each event's title, time, place, organizer and who's invited
(the first 20, with a count of the rest), not its description. A Google list can also search with `query`, for words
in the title, place, description and people.

## Times

- **What a tool takes:** a time with its offset, such as
  `2026-11-03T09:00:00+01:00`, or a day for an event that lasts all day, such
  as `2026-11-03`. An event's `start` and `end` are both times or both days.
  For days, `end` is the day after the last, as both calendars count them.
- **What a tool gives:** times in UTC, such as `2026-11-03T08:00:00Z`, and
  days for an all-day event.
- **A window** for a list or for free/busy is at most 31 days.
- **A repeating event** is listed one occurrence at a time, each with its own
  id.

## Invitations

- **Google:** a create or an update tells everyone invited: Google sends an
  invitation, an update or a cancellation.
- **Outlook:** a create always sends each attendee a meeting request.
  Microsoft has no way to skip it. An update that changes only who's invited
  sends one only to the people it adds or leaves out
  ([Microsoft: Update event](https://learn.microsoft.com/en-us/graph/api/event-update)).

Because an event reaches other people's calendars, a create or an update
in a run that no person started waits for a yes first: the person's, or a
reviewer's for the company's calendar, just as for a send
([Ask before a tool runs](../../approvals/ask-before-a-tool-runs/)). On
the person's own calendar, a list and a free/busy wait for their yes too,
as every call with a person's connection does in such a run
([Use a connection](../use-a-connection/#approvals)).

A create or an update runs once per call. If its step runs again, after a
wait or a retry, it gets the first call's answer.

## What an update can change

An update changes one event on the calendar, or one occurrence of a
repeating one, by the id a list gave. It can change the title, the time,
the place, the description, and who's invited. `attendees` is everyone
after the change. It never changes a whole series: give it an occurrence's
id.

The calendar decides what the account may change. For an event someone else
organizes, Google and Microsoft refuse most changes, and the tool returns
their refusal in their own words.

## Permissions and review

Your own client or app asks for these permissions, so Google and Microsoft
review your registration, not Kindgi's.

- **Google:** `calendar.events.owned.readonly` to list,
  `calendar.freebusy` for free/busy, and `calendar.events.owned` to add and
  change. The two event permissions reach only calendars the account owns,
  and `calendar.freebusy` shows only when it's free or busy. Google counts
  calendar permissions as sensitive.
  - With **Audience: Internal**, there's no review.
  - With **External**, an app Google hasn't verified shows its "unverified
    app" screen and takes at most 100 accounts, as for Gmail
    ([Google](../google/#1-create-the-client-in-the-google-cloud-console)).
- **Microsoft:** `Calendars.ReadBasic` to list and for free/busy, and
  `Calendars.ReadWrite` to add and change. Neither needs an admin's consent
  by default. Your directory may still ask for it
  ([Admin consent](../microsoft/#admin-consent)).

## A connection made before

A connection someone made for mail has only mail permissions. In a run
they started, a calendar tool's call waits for them to allow the
calendar, as for any permission a connection lacks
([When the connection is missing](../use-a-connection/#when-the-connection-is-missing)).
In any other run, it fails with `connection-missing`
([Errors when a call uses a connection](../reference/#errors-when-a-call-uses-a-connection)).
Connecting again asks for what the connection had as well as the calendar,
so their mail keeps working, with Google and with Microsoft.

## Limits

- **Google:** Kindgi paces each connection's calendar calls at 600 a minute,
  the Calendar API's limit for one person
  ([Google: Calendar API usage limits](https://developers.google.com/workspace/calendar/api/guides/quota)).
  They don't count against Gmail's units. Google enforces its limit for your
  whole Cloud project itself.
- **Outlook:** calendar calls count against Microsoft Graph's 10,000 calls in
  10 minutes for the mailbox. A create or an update also counts as one of
  the 30 sends a minute, since it can send meeting requests
  ([Microsoft](../microsoft/#limits)).

## Not here yet

- Starting a run when an event is booked, changed or about to start.
- Other people's calendars, shared and delegated calendars, and free/busy
  for colleagues.
- Deleting an event, and making or changing a repeating series.
