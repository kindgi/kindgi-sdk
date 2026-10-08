---
"@kindgi/api": patch
---

Memory erasure (T273 M-5): an erasure takes effect for agents at once. From the moment it starts until it completes, no memory read returns the facts it names (the person's, one fact, a conversation's), even before they're cleared, and starting a turn for that person (their conversation, their `participantId`, or the user it acts for) is refused with `409 erasure-in-progress`. A turn already running or waiting isn't refused: the erasure ends or waits for it.
