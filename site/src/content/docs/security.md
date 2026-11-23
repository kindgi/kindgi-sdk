---
title: Report a security issue
description: How to tell Kindgi about a security vulnerability, privately, and what happens next.
---

If you find a security vulnerability in Kindgi (the SDKs, the CLI, the
runtime, a Terraform module or the WordPress plugin), report it privately,
by email to [contact@kindgi.com](mailto:contact@kindgi.com), with "Security"
in the subject. Don't report a suspected vulnerability anywhere public.

Include what you can:

- the packages or modules, and their versions;
- what the issue is, and what it lets someone do;
- the steps, or a proof of concept, that reproduce it.

We acknowledge the report, keep you informed while we look into it, and
credit you in the [release notes](../releases/) unless you'd rather we
didn't.

Kindgi is in preview (`0.x`): a security fix goes into the newest release
only, so upgrade to it to get the fix.

For how Kindgi keeps tenants apart, authenticates callers and handles
secrets, see [Security](../concepts/security/).
