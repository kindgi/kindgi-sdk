# Common mistakes

1. **File-path-only entries** ("bug in router.ts").
   Without a reproducer + expected behavior, the maintainer has to
   reverse-engineer your session. File:line is necessary but not
   sufficient.
2. **Skipping "Suggested fix" when you have one.** If you diagnosed
   the root cause, name it. "Add `preferredProvider` to `AgentSchema`
   in `packages/api/src/openapi/schemas.ts:667`" is worth a dozen
   back-and-forth clarifications.
3. **Bundling multiple bugs into one entry.** Run `kindgi feedback
   write` once per bug. Each gets its own number, its own fix
   status, its own removal path.
4. **Sensitive state in reproducers.** Reproducer sections sometimes
   contain API keys, tenant IDs, secrets — review before committing,
   and read the preview before anyone says yes to sending.
5. **Filing "the way I'd design it" as a bug.** Design disagreements
   are `--kind=design`, not `--kind=bug`. Both are welcome; the
   classification helps prioritization.
