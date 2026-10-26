---
"@kindgi/cli": patch
---

**`kindgi secrets revoke --hard` says what setting the name again does.** Where your secret manager keeps a recoverable copy, the note after a hard revoke said that setting the name again before the copy's purge date keeps it, disabled, until the next hard revoke. Setting the name again first purges that copy where Kindgi now can, so the note now says: "If you set this name again before then, Kindgi purges the copy if it now can; if it still can't, the copy stays, disabled, until you hard-revoke it again."
