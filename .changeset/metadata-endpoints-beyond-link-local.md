---
"@kindgi/env-schema": patch
"@kindgi/api": patch
---

**The cloud metadata endpoints a runtime refuses aren't only link-local.** From runtime 0.1.8 the class also holds the ones clouds serve outside 169.254.0.0/16 and fe80::/10: Azure's 168.63.129.16, Alibaba Cloud's 100.100.100.200, AWS's fd00:ec2::254 and EKS Pod Identity's fd00:ec2::23, Compute Engine's fd20:ce::254 (IPv6-only VMs), Akamai's fd00:a9fe:a9fe::1 and Scaleway's fd00:42::42.
- `KINDGI_TENANT_HOST_ACCESS`'s description names them as the cloud metadata endpoints, not link-local addresses alone.
- `KINDGI_WEBHOOK_PRIVATE_NETWORKS`'s description says they stay refused even with `allow`, though some sit inside CGNAT or IPv6 unique-local space.
- `HostReach`'s `'metadata-network'` lists them, and says it also covers addresses no tenant has a reason to reach (multicast, reserved, documentation).
