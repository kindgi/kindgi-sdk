---
"@kindgi/cli": patch
---

**`kindgi init --template=woocommerce`'s README says which addresses to allow at the store:** under **Connect your store**, a store whose host has a firewall or bot protection allows the addresses `kindgi egress --hosted` prints, and the `deployments` ones are where the tools' calls come from.
- It says how a call looks until the host allows them: `fetch failed`, often after about 10 seconds, or `WooCommerce answered 403` with the start of the host's own page.
- Every tenant on the runtime calls from the same addresses, so the Application Password stays the check on who gets in.
