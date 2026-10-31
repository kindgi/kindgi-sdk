---
"@kindgi/connections": patch
"@kindgi/sdk": patch
---

**Calendar tools.** `@kindgi/connections/google/tools` adds `googleCalendarEventsList`, `googleCalendarFreeBusy`, `googleCalendarEventCreate` and `googleCalendarEventUpdate`, and `@kindgi/connections/microsoft/tools` adds `outlookCalendarEventsList`, `outlookCalendarFreeBusy`, `outlookCalendarEventCreate` and `outlookCalendarEventUpdate`. They list the events in a window of at most 31 days, say when the calendar is busy, and add or change an event, on the calendar of the account the run acts as. `as: 'company'` uses the company's calendar a tenant admin connected. Each asks for the least access its call takes.

- **Times.** A tool takes a time with its offset, or a day for an all-day event, and gives times in UTC. An event's `start` and `end` are both times or both days.
- **Invitations.** A create or an update tells the people it invites, so both are mutating tools that wait for a yes in a run no person started. A create runs once per call: a step that runs again gets the first create's answer.
- **What an update changes.** One event, or one occurrence of a repeating one, by the id a list gave. It refuses a whole series.
- **Permissions.** The Google entry adds `calendar.events.owned.readonly`, `calendar.freebusy` and `calendar.events.owned`, each with review `sensitive`; the Microsoft entry adds `calendars.readbasic` and `calendars.readwrite`. A connection made for mail only lacks the calendar permissions: in a run the person started, the call waits for them to allow them; in any other, it fails with `connection-missing`.
- **Rate limits.** Google calendar calls are paced at 600 a minute per connection, apart from Gmail's units. Outlook calendar calls count against Graph's mailbox limit; a create or an update also counts against the 30 a minute that sends do.
- **Docs.** A new Calendars guide, the calendar steps in the Google and Microsoft setup guides, and the calendar tools in the tools authoring skill.
