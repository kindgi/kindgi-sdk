---
"@kindgi/env-schema": patch
---

**The server's AWS identity, in the env schema** (group `aws`):
- `KINDGI_AWS_IDENTITY`: `container`, `instance`, `web-identity` or `profile` (development only);
- `KINDGI_AWS_PROFILE`;
- `KINDGI_AWS_ROLE_ARN`, a role to assume, with `KINDGI_AWS_ROLE_SESSION_NAME` and `KINDGI_AWS_STS_REGION`.

The runtime that reads them signs in to AWS only as they name, never with the AWS SDK's default chain. The Bedrock adapter's `auth: aws-identity` is its first user.
