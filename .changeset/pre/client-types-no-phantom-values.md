---
"@kindgi/client": patch
---

`@kindgi/client`'s published types declare as values only what the package exports at runtime. The generated wire schemas (`LivePin`, `LiveScope`, `Promotion`, `GatePolicy`, `RunProgress`, `Block` and the others) are types; the bundled `.d.ts` also declared each as an exported `const`, so `LivePin.parse(…)` compiled and then failed at runtime (the module has no `LivePin`). Using one as a value is now a compile error ("'LivePin' only refers to a type"); importing them as types is unchanged.
