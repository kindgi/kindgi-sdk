---
'@kindgi/api': patch
'@kindgi/client': patch
---

**A test set's cases name their judgments, and a proposal says how many it rests on.** Each item of a judged case now carries `judgmentIds`, the judgments counted in it, and `restricted.judgmentIds`, the ones recorded while their class was restricted. A test set built before them has neither. A proposal's `evidence` gains `judgmentCount`: how many judgments it rests on when `judgmentIds` names only the first of them. An improvement pass names at most 100 of the judgments it learned from on the cases it searched, never the hold-out. `judgmentCount` is in answers only: a proposal you create still names its judgments with `judgmentIds`. `FixProposal.evidence` is now the named `ProposalEvidence` schema, with the same fields plus this one.
