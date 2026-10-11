---
'@kindgi/cli': patch
---

`kindgi init --template=drupal`: the content agent says a change that waited for a person was done once it was. Its instructions told it that its two writes "wait for a person to approve", and the model never sees the approval itself, so after both were approved it still said they were waiting. They now say what a result from `set_moderation_state` or `update_content` means: a rejection is the reviewer declining, with their reason; a failure is a change that was approved but didn't go through (Drupal refused it), with the error; and any other result is a change a person approved and that was done. It looks the article up again before stating its state. A new pack test keeps the instructions naming every tool the approval policy holds back. The content reviewer now always reads the article as it is now before it writes its note, rather than only sometimes.
