# A worked example: the return window

A support lead corrects a refund: "Shouldn't have refunded — delivered 20
days ago, our window is 14." The correction says the decisions were wrong,
with `mustNotCall: ["issue_refund"]`, so Kindgi sorted it to the agent's
owner, and the owner passed it to a developer. You pull it (Step 1) and see
the window is a store policy, not a one-off.

- **If the agent already reads a `returnWindowDays` setting:** it's a
  setting. Suggest a change to the block with `returnWindowDays: 14`, and
  `--fixes` naming the correction (Step 3, a suggested change). Read its
  check: the correction should pass on `with` and fail on `now`, and nothing
  should be newly failing. Then ask to pin it, or add it as Latest when the
  project follows its Latest. Tell the owner they can change this setting
  themselves in the console.
- **If it doesn't read one yet:** it's code. In the pack, add
  `returnWindowDays` to the settings block's file (its schema: whole days,
  0 to 365; its value: 14) with a new version, make the refund tool read it
  and refuse an order delivered more than that many days ago (offering a
  person), and add a test: an order delivered 20 days ago is refused. Leave
  `x-kindgi-tunable` off: the window is a rule, not wording. Open the pull
  request, mark the correction `being-fixed` with its URL, and after the
  merge the deploy makes the version (Step 3, in code).

Either way, the version is pinned with a reason like "Fixes 1 correction:
our return window is 14 days", and the pin marks the correction Fixed in
that version (Step 4). The refund limit, the most a refund can be without a
person, is never raised here: the cap stays in the tool's code, and the
large-refund tool still always asks.
