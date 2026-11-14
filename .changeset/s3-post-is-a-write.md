---
"@kindgi/api": patch
---

A closing or suspended workspace can no longer start or complete a multipart upload on the S3-compatible surface under a key that ends as one of the API's revoke or unregister paths do (`…/revoke`, `…/revoke-sessions`, `…/unregister`). Every S3 `POST` it makes gets `403 AllAccessDisabled`, as its other writes do.
