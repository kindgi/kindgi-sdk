---
"@kindgi/api": patch
"@kindgi/client": patch
"@kindgi/env-schema": patch
---

Reviewers can be told when an approval waits for them.

- **`approval.requested` webhook event:** an endpoint can subscribe to it like `run.finished`.
  - **When:** sent each time an approval starts waiting (an escalation opens a new one).
  - **What:** `data.approval` carries `approvalId`, `projectId`, `requiredRole`, `title`, `assignedTo`, `createdAt`, `expiresAt` and `url`. Never what the approval is about: no `context`, tool call or run input.
  - **Filter:** the endpoint's `projectId` narrows it to the approval's project.
- **`KINDGI_REVIEWER_EMAIL`** (off by default): `on` emails reviewers through the emailed sign-in link's server.
  - **Who:** the people the approvals list would show the approval to, only those who may read its project.
  - **How often:** the first email goes at once, then a five-minute digest.
  - **What:** title, project, required role and a link only.
  - **Without the server:** turned on without `KINDGI_AUTH_EMAIL_SMTP_URL` and `KINDGI_AUTH_EMAIL_FROM`, the runtime refuses to start.
- **Clients:** the TypeScript and Python clients type the new event. The Python client's `parse_event` reads it.
