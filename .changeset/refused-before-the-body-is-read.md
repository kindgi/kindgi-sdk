---
"@kindgi/api": patch
---

A workspace past its limit on API requests a minute, and a closing or suspended workspace writing on the S3-compatible surface, are now refused before an upload's body is read, so an upload is no longer read whole only to be refused. On `/s3`, such a write gets `403 AllAccessDisabled` or `503 SlowDown` even when its body is too large or doesn't match its signed hash (it got `400 EntityTooLarge` or `XAmzContentSHA256Mismatch` before). On `/v1`, an upload past the minute gets `429 rate-limit-exceeded` before its size is checked. A request is counted in the minute before its route's body is read, so one that's then refused still uses one of the workspace's requests: an upload or an S3 write refused for its body, a request whose JSON is nested too deep, or one refused by the checks before its route. Any other `/v1` body over the API's size limit is still refused first, before the caller is known, and isn't counted.
