---
"@kindgi/env-schema": patch
"@kindgi/api": patch
---

**More cloud metadata endpoints are refused.** Besides 169.254.0.0/16, fe80::/10 and AWS's fd00:ec2::254, from runtime 0.1.8 the cloud metadata endpoints a runtime refuses also include Azure's 168.63.129.16, Alibaba Cloud's 100.100.100.200, EKS Pod Identity's fd00:ec2::23, Compute Engine's fd20:ce::254 (IPv6-only VMs), Akamai's fd00:a9fe:a9fe::1 and Scaleway's fd00:42::42.
- `KINDGI_TENANT_HOST_ACCESS`'s description names them as the cloud metadata endpoints, not link-local addresses alone.
- `KINDGI_WEBHOOK_PRIVATE_NETWORKS`'s description says they stay refused even with `allow`, though some sit inside CGNAT or IPv6 unique-local space. Its `allow` list also names IPv6 site-local, which runtime 0.1.8 counts as private.
- `HostReach`'s `'metadata-network'` lists them, and says it also covers addresses no tenant has a reason to reach (multicast, reserved, documentation).
