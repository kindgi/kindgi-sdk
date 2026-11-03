# Declarative HTTP spec

```ts
// tools/fetch-order/index.ts
import { defineTool } from '@kindgi/sdk/define';
import type { ToolId } from '@kindgi/sdk/types';
import { z } from 'zod';

const defined = defineTool({
  id: 'shop.fetch-order' as ToolId,
  description: 'Fetch an order by id from the storefront API.',
  version: '0.1.0',
  input: z.object({ orderId: z.string() }),
  output: z.object({ id: z.string(), status: z.string(), total: z.number() }),
  effects: [],
  mutating: false,
  spec: {
    kind: 'http',
    method: 'GET',
    urlTemplate: 'https://api.shop.example/orders/{orderId}',
    // Every {placeholder} MUST be a key on the input schema
    authorization: {
      kind: 'bearer',
      secretRef: { envName: 'production', name: 'shop-api-token' },
    },
    successStatus: { min: 200, max: 299 },
  },
});

if (defined.kind === 'err') throw new Error(defined.error.message);
export default defined.value;
```

`timeoutMs` (default 30 seconds) covers the whole call, reading the response included, and so does a run's cancel. A response body over 10 MiB, counted after it's decompressed, fails the call. So point a tool at an endpoint that pages or filters, not one that returns everything.
