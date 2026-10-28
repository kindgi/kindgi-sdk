# Step 3: make the change, with a test per correction

Make each change in the layer you sorted it to, and add **one pack test per
correction** so the mistake can't come back:

- **Code (a tool):** add the check in the tool, and a test that the corrected
  case is now refused or handled right (the 20-day-old order is refused, the
  final-sale item isn't refunded). Follow your pack's language:
  `kindgi-authoring-tools` (TypeScript), `kindgi-python-authoring-tools`,
  `kindgi-java-authoring-tools`, or `kindgi-scala-authoring-tools`. Run the
  pack's tests the way that skill shows — `kindgi test` wraps `vitest` for a
  Node pack; a Python, Java or Scala pack runs its own test runner.
- **A setting:** decide the key, its limits and its default, and publish the
  settings block (Step 4). Add a test that the tool reads the setting and
  acts on it.
- **Instructions for Improve:** you don't write the prompt — you make sure the
  corrected cases are in the test cases, then let an Improve run try wordings
  on them (`kindgi proposals improve`). It writes a *suggested* change only
  when a wording does better on those cases, and a person
  decides whether to take it; nothing is applied on its own.

Write tests with invented data (rule 3 under "What stays with the person" in `SKILL.md`). A correction that belongs
to the owner (a setting they'd rather own) or an approver (an approval rule)
is theirs to make — say so, and give them the one command or the console
page, don't do it for them.
