---
"@kindgi/tools": patch
---

**A tool's context names the workspace's time zone.** `ToolContext` gains `timeZone?: string`, an IANA name such as `America/Toronto`: an agent turn reads it once, from the workspace's `time-zone` fact, and every call the turn makes gets the same one, `UTC` when the workspace sets none or it can't be read. A tool that answers a date or a time answers it in this zone. It's absent outside an agent turn and from an older runtime, so a tool uses UTC then.
