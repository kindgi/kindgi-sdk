---
"@kindgi/connections": patch
"@kindgi/sdk": patch
---

**The calendar tools read several calendars.** `googleCalendarCalendarsList`, from `@kindgi/connections/google/tools`, and `outlookCalendarCalendarsList`, from `@kindgi/connections/microsoft/tools`, list the calendars of the account the run acts as, or the company's with `as: 'company'`: each with its `id`, its `name`, whether it's the `main` one, the `access` the account has, and its `owner` when that's someone else. The events lists and free/busy take up to 10 of those ids in a new optional `calendarIds`.

- **Without `calendarIds`,** a list or a free/busy reads the main calendar and answers as before.
- **Over several calendars,** a list gives each event with its `calendarId`, merged by start, with `top` counted across them, and a free/busy joins their busy times. When Google or Microsoft refuses one of the calendars, the call fails and names it. Google reads only calendars the account owns. Outlook's free/busy reads at most 1000 events across the calendars.
- **Permissions.** The Google entry adds `calendar.calendarlist.readonly`, with review `sensitive`, which only the calendars list asks for. A Google connection made before lacks it until the person allows it. Outlook's calendars list uses `calendars.readbasic`, as its events list does. Google paces `calendar.calendarList.list` with the other calendar calls, and Outlook's `outlook.calendars.list` doesn't count against sends.
- **Versions.** The events lists and free/busy move to 1.1.0, as person and as company. The calendars lists start at 1.0.0.
- **Docs.** The Calendars guide shows how to read several calendars, the Google setup guide adds the new permission, and the tools authoring skill names the calendars lists.
