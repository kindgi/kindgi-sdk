---
"@kindgi/log": patch
"@kindgi/client": patch
---

A record written with `inMessage` (the fields its message already states, like the request line's `method`, `route`, `status` and `durationMs`) names them in its JSON as `inMessage`, listing the ones the record has. A renderer may leave them out of a line. `formatPretty` does, so a record read back from JSON renders as it did at the source. A field an app itself calls `inMessage` is kept under `fields`, like one named after the fixed five. Python's `kindgi.log` does the same (`in_message=`).
