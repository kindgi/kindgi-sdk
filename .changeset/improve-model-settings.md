---
'@kindgi/agents': patch
'@kindgi/api': patch
'@kindgi/client': patch
---

**An improvement pass can try a cheaper model or another temperature, and keeps one only when the decisions stay right.** A model-settings block may now name the model the turn prefers, `model` and `providerId`, used instead of the agent's `preferredModel` and `preferredProvider`. An agent version that names its model in both is refused at publish and at deploy, and so is a version derived to pin such a block. A pass now tunes the model-settings block's keys marked `x-kindgi-tunable` like any settings block's, within the bounds model settings allow. It tries `model` and `providerId` only when the agent names no model itself. A change to that block is kept only when no correction the current version passes fails, with at least one checked. It's kept when it's better, or when it's no worse than the current version replayed on the same cases and costs less, beyond the spread. A proposal's `evaluation` gains `rule` (`better` or `cheaper`), `costUsd` and `decisions`. A proposal kept as `cheaper` reads `evaluated`, so `evaluated` doesn't always mean better. A judged comparison's summary gains `costUsd` and `corrections.judgments`, and each case result gains `costUsd`, one per repetition. A test set's hold-out split now puts cases that carry a correction in both parts when there are two or more.
