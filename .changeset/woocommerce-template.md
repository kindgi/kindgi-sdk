---
'@kindgi/cli': patch
---

`kindgi init --template=woocommerce` scaffolds agents for a WooCommerce store. Typed tools call the store's REST API as a dedicated WordPress user with an Application Password, which is kept as a secret. A store assistant looks up orders and refunds up to 100 on its own. A larger refund, a price change and publishing a product each wait for a person to approve. Because approval rules name a tool, the limit is two refund tools, enforced by the input schema and by a running total per order. A flow reviews each new order: a check step keeps only typed fields before any model sees the event, and the agent that reads events can only look orders up.
