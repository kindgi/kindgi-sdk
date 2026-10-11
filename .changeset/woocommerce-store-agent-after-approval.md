---
'@kindgi/cli': patch
---

`kindgi init --template=woocommerce`: the store agent says a change that waited for a person was done once it was. Its instructions told it to say `refund-large` "waits for a person", and the model never sees the approval itself, so after an approval it still said the refund waited, or told staff to check that it went through. They now say that a result from `refund-large`, `set-price` or `publish-product` means a person approved it and it was done, and that a rejection is the reviewer declining, with their reason. A new pack test keeps the instructions naming every tool the approval policy holds back.
