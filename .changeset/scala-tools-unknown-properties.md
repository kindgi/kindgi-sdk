---
"@kindgi/sdk": patch
---

The Scala tools authoring skill now says that a tool's input or output case class refuses unknown properties unless it says `@JsonIgnoreProperties(ignoreUnknown = true)`, as the Java skill says for a record.
