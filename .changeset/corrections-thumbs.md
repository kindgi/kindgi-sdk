---
"@kindgi/client": patch
---

**`client.corrections.thumbs` records an end user's thumbs up or down from your app's server.** `thumbs({ runId, participantId, up, why })` posts a correction of the run's answer, made for the end user: `answer: "right"` for a thumbs up, `"wrong"` for a thumbs down, with their words as `why`. A thumbs down needs `why`, and without it the API answers 400. Your page posts the thumbs to your server, which calls this, so a Kindgi token never reaches a browser. The Python client has `client.corrections.thumbs(run_id=..., participant_id=..., up=..., why=...)`.
