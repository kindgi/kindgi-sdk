---
'@kindgi/cli': patch
---

`kindgi init --template=woocommerce`: only single tokens from an order reach the order reviewer's instructions. The order check now requires a status slug and an ISO currency code, and replaces an order number that isn't one token with the order's id. A new test keeps the reviewer's instructions to the order's number, total, currency, status and flags, asking Liquid for every variable they read; the rest of the order stays in the step's input, as data.
