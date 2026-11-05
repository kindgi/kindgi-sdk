---
"@kindgi/cli": patch
---

**`kindgi init --template=returns-helper` scaffolds a date and time tool.** The helper gets a third tool, `<pack-id>.today`, which answers the date, the weekday and the time in the workspace's time zone (`ctx.timeZone`, UTC without one), with its test in `tools/today/index.test.ts`. Its instructions tell it to ask the tool before answering anything that depends on the date.
