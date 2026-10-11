---
'@kindgi/cli': patch
---

`kindgi init --template=woocommerce` pins zod ^4.6.5, vitest 5 and vite 8, like the other fresh templates. The checks that the fresh templates pin the versions Kindgi is tested with now cover every template with a `package.json`, so a template added later can't keep an older pin.
