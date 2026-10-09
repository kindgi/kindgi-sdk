---
"@kindgi/api": patch
"@kindgi/client": patch
---

Paging `GET /v1/observations` no longer skips observations recorded at the same instant as a page's last one. The next cursor was that observation's bare time, with no tie-breaker; it now carries its position (the time as stored, and its id), when the deployment gives it. A bare-time cursor a client already holds still answers as before. The binding gains `SupervisorObservationPage.next` and `SupervisorQueryObservationsInput.after` (both optional; without them the route pages as before). A cursor that is neither a position nor a time, or a position whose id isn't an id, is `400 bad-input`. The cursor descriptions of the observations and approvals pages no longer say it's a timestamp: it's opaque.
