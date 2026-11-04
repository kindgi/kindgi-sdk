---
"@kindgi/connections": patch
---

**`mailTurn` sets in every line of a mail's text that would read as one of the turn's own, not only a `---` line.** A line that starts with `[the rest of this mail is cut]` or `(no text)`, or with `To:`, `Cc:`, `Reply-To:` or `Attachments:` in any case, with or without a space after the colon, after any characters that don't show, now starts with one space, as a line starting `---` already did. Before, a new mail with no recipients whose text began `To: …` read to the agent as naming them, and so did a mail with no attachments whose text ended `Attachments: …`, a text ending in the cut line, and a text of only `(no text)`.

- **A mail turn's `body` sets in a line that starts as `[earlier mail left out]`,** the mark a Gmail quote cut leaves, on Gmail and Outlook alike, so only the cut's own mark reads as one. That `body` is also the `mail` a flow started from new mail gets. A read tool's text is as before.
- Otherwise `input` (`mail`, `thread`, `leftOut`) and `covered` are as before.
- The WordPress plugin reads those lines as the mail's text and shows them without the space. An earlier plugin shows them with it, and no longer takes them for the mail's own.
- **Docs.** Start runs from new mail says which lines are set in.
