---
"@kindgi/connections": patch
---

**`mailTurn` sets in every line of a mail's text that would read as one of the turn's own, not only a `---` line.** A line that starts with `[the rest of this mail is cut]` or `(no text)`, or with `To:`, `Cc:`, `Reply-To:` or `Attachments:` in any case, with or without a space after the colon, after any characters that don't show, now starts with one space, as a line starting `---` already did. Before, the agent could take a new mail's first line `To: …` for its recipients when it had none, a last line `Attachments: …` for attachments, a last line `[the rest of this mail is cut]` for a cut, and a text of only `(no text)` for none.

- **Each mail a mail turn's read gives, its `mail` and every mail of its `thread`, sets in a line of its `body` that starts as `[earlier mail left out]`,** the mark a Gmail quote cut leaves, on Gmail and Outlook alike, so only the cut's own mark reads as one. A flow started from new mail gets those mails as `input.mail` and `input.thread`. A read tool's text is as before.
- Otherwise `input` and `covered` are as before.
- The WordPress plugin reads those lines as the mail's text and shows them without the space. An earlier plugin shows them with it, and no longer takes them for the mail's own.
- **Docs.** Start runs from new mail says which lines are set in, and that a flow's `mail` sets in the mark.
