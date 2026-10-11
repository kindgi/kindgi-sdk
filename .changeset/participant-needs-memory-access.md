---
"@kindgi/api": patch
---

**A turn runs as a participant only for someone who may read their memory.** A turn runs with its participant's memory: their `same-user` facts and earlier conversations are read into it and returned in its result, and what it remembers is kept as theirs. So running as a participant now takes what reading their memory takes through the memory API:
- **Either:** the participant is the caller (a person, by their user id; never a service account's key);
- **or:** the caller holds `write` on the turn's project, acting for all its end users (an app's service account, an editor).

**Where it's checked:** every way a turn gets a participant.
- **Posting into a conversation:** its stored participant wins, whatever the body names.
- **`input.participantId`** on `POST /v1/runs`.
- **Opening a conversation for someone:** `participantId` on `POST /v1/conversations`.

Anything else is refused with 403 `participant-not-allowed`, and recorded as other refusals are.

**Who it affects:** before, anyone who could run an agent could run it as any participant. Today, every role that can run an agent also holds `write`, so nothing changes for them. The check is for callers that may run an agent without `write` on its project.
