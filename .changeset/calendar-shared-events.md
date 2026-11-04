---
"@kindgi/connections": patch
"@kindgi/sdk": patch
---

**The calendar tools read calendars others share.** `googleCalendarSharedEventsList`, from `@kindgi/connections/google/tools`, and `outlookCalendarSharedEventsList`, from `@kindgi/connections/microsoft/tools`, list the events in a window as the events lists do, with the same input and output, and also on a calendar someone else owns that the account has, such as a colleague's or a family calendar. They act as the person, or as the company with `as: 'company'`.

- **Opt-in.** They ask for a wider permission than the events lists, so only a pack that includes one asks for it. The events lists, free/busy and the calendars lists are unchanged.
- **Permissions.** The Google entry adds `calendar.events.readonly`, with review `sensitive`, and the Microsoft entry adds `calendars.read.shared` (Calendars.Read.Shared, no admin consent by default). A connection made before lacks them until the person allows it. Add the Google one to your OAuth client's Data access, and the Microsoft one to your app's API permissions.
- **Versions.** Google's starts at 1.0.0 and Outlook's at 1.1.0, as person and as company.
- **Docs.** The Calendars guide shows the shared lists and their permissions, and no longer says Outlook's events list reads a shared calendar with the same permission as the main one: Microsoft's pages name a wider permission for one. The Google and Microsoft setup guides add the new permissions, and the tools authoring skill names the shared lists.
