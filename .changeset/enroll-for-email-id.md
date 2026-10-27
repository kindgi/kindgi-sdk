---
"@kindgi/cli": patch
---

`kindgi license enroll --for` says it takes the `em-` id the key page shows, as well as a GitHub login. Someone who signs in by email gives that id, and so does someone who first signed in by email and now signs in with GitHub. Its help, its usage line, the message when `--for` is missing, the error for a value that isn't one, and `kindgi license renew`'s pointer to enroll all said a GitHub login only. What `--for` accepts is unchanged: an `em-` id was already accepted. And `enroll`'s output says to add the line "signed in as the person it's for (<account>)", not "signed in as <account>": the key page names someone who signs in by email by their address, not by the `em-` id.
