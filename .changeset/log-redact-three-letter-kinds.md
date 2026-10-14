---
"@kindgi/log": patch
---

**Security hardening: the license renewer's key is now masked in logs.** Redaction matched a Kindgi token's kind only when it had two letters, so the license renewer's private key (`kgi_lrk_…`) and public key (`kgi_lrp_…`) were written in full when they appeared in a log line. A kind may now have two or three letters, and those keys keep only their prefix and last four characters, like every other token. The Python (`kindgi.log`) and Java (`com.kindgi.log`) loggers change the same way. Ordinary text that contains `kgi_` is still left alone.
