---
"@kindgi/api": patch
"@kindgi/client": patch
"@kindgi/cli": patch
---

**Removing a person from the workspace removes the connections they own too.** A connection's `removedReason` gains `owner-removed`: the person who owned it was removed from the workspace. Each one goes as a disconnect does: withdrawn at its app where the app allows, and its stored token destroyed, so a run that was still acting as them finds no connection to act with. `removedReason` now says what each of its values means, and `POST /v1/identity/users/{userId}/unregister` and `kindgi people remove` say that a person's connections go with them. A client that reads `removedReason` can meet the new value; the Python client already takes values it doesn't know.
