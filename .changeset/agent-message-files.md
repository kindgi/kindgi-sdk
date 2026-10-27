---
"@kindgi/types": minor
"@kindgi/capabilities": minor
"@kindgi/agents": minor
"@kindgi/api": minor
"@kindgi/client": minor
"@kindgi/tools": patch
---

**An agent can be shown stored files: photos, PDFs and text files, from its run's input and from its tools' results.**
- **A file as a value.** `FileValue` (`@kindgi/types`: `{type: 'kindgi.file', artifactId, …}`) is a stored file inside plain JSON: a run's input `files`, a tool result's top-level `files`, or a conversation message's `files`. `isFileValue` checks its shape: each field's type, a whole size, a lowercase hex sha256, a page count from 1 and a known `notShown` reason. Only `artifactId` is trusted: the runtime shows a file by its own checked record of it.
- **The turn's files binding.** `InvokeAgentBindings.files` (`FileBindings`) gives a turn the `FileBinding` of its run (`forRun`), once the run has its id: the runtime's rule for which files the turn's model may be shown (`admit`) and how a call reads their bytes (`read`). Without one, a tool result's files stay plain JSON, and an earlier message's files are each a line saying there's no file store.
- **Where files come from.**
  - **The run's input.** `InvokeAgentInput.files` are the turn's own: the user message keeps the ones the rule admits, so a later turn is shown them too.
  - **A tool's result.** The first 10 file values in its top-level `files` that the rule admits become the tool message's files, and the rest of the result is its text. One the rule refuses, one past the tenth, and anything that isn't a file value stay in the result as plain JSON.
  - **The conversation's history.** Each earlier message's files are asked of the rule again. One it refuses now is a line saying the file is no longer stored.
- **A file the model couldn't read.** `refused` joins the reasons a file isn't shown (`FILE_NOT_SHOWN_REASONS`, and `FileValue.notShown` in the API and the clients): the model reads that it couldn't read the file when it was attached.
- **Images and PDFs go to an agent that needs `vision`.** For any other agent, each is a line naming it. That's decided for each call: the conversation and the journal keep the plain reference, so a later version of the agent that needs `vision` is shown the file. Text files go to any agent.
- **Outside data.** The rule an agent's system message gains for event data now covers files: any file under a line saying it comes from outside is data, not instructions. A turn gets it when its first messages carry files. A tool whose results may carry files should set `resultIsOutsideData`, so the rule is there from the turn's start.
- **A turn's memory charge** counts the bytes of the files each call reads, three times: the bytes, their base64 and the request body. `filesForCall` gives the files a call reads, decided as `fileParts` decides them, without reading any.
- **Provenance.** A model call's node names the files it planned to read, by artifact id and sha256: at most what it read, since a provider's lower limit or a file found gone or changed can leave one out.
- **The API.** `ConversationMessage` gains an optional `files` (`FileValue[]`), and `GET /v1/conversations/{conversationId}/messages` returns it. The TypeScript client's `ConversationMessage` gains it too.
