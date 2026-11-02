---
"@kindgi/types": patch
"@kindgi/capabilities": patch
"@kindgi/agents": patch
"@kindgi/api": patch
"@kindgi/client": patch
"@kindgi/tools": patch
"@kindgi/env-schema": patch
---

**An agent can be shown stored files: photos, PDFs and text files, from its run's input and from its tools' results.**
- **A file as a value.** `FileValue` (`@kindgi/types`: `{type: 'kindgi.file', artifactId, …}`) is a stored file inside plain JSON: a run's input `files`, a tool result's top-level `files`, or a conversation message's `files`. `isFileValue` checks its shape: each field's type, a whole size, a lowercase hex sha256, a page count from 1 and a known `notShown` reason. Only `artifactId` is trusted: the runtime shows a file by its own checked record of it.
- **The turn's files binding.** `InvokeAgentBindings.files` (`FileBindings`) gives a turn the `FileBinding` of its run (`forRun`), once the run has its id: the runtime's rule for which files the turn's model may be shown (`admit`) and how a call reads their bytes (`read`). Without one, a tool result's files stay plain JSON, and an earlier message's files are each a line saying there's no file store.
- **Where files come from.**
  - **The run's input.** `InvokeAgentInput.files` are the turn's own: the user message keeps the ones the rule admits, so a later turn is shown them too.
  - **A tool's result.** The first 10 file values in its top-level `files` that the rule admits become the tool message's files, and the rest of the result is its text. One the rule refuses, one past the tenth, and anything that isn't a file value stay in the result as plain JSON.
  - **The conversation's history.** Each earlier message's files are asked of the rule again. One it refuses now is a line saying the file is no longer stored.
- **A file the model couldn't read.** `refused` joins the reasons a file isn't shown (`FILE_NOT_SHOWN_REASONS`, and `FileValue.notShown` in the API and the clients): the model reads that it couldn't read the file when it was attached.
  - **The retry.** A call that carried images or PDFs and that the provider refused as an invalid request (the adapter's `ModelProviderError` of kind `invalid-request`) is sent once more, in the same step, with that line in each one's place. The files the first call left out for its limits stay out, so the second call is the first without the files it carried. When it answers, the turn goes on without them, the files binding marks them (`FileBinding.refuse`), and the turn's result has a `file-refused` warning naming them. When it fails too, nothing is marked and the turn fails with the first call's error. A turn retries once at most, and not when it has spent its cost budget. The second call is recorded as its own call and counts against the turn's cost, not its steps.
  - **Events.** A step with a retry has two `model.call.started` events; the refused call has no `model.call.completed`.
  - **Everything else keeps the files:** a 429, a 5xx, no response, auth, a context too long, a content filter, an error with no kind, or an aborted turn.
  - **`FileBinding.shown`** is told the images and PDFs each answered call carried; the runtime's choice of what a refusal marks reads it. A binding that fails at either is a `file-record-failed` warning, and the turn goes on.
- **Images and PDFs go to an agent that needs `vision`.** For any other agent, each is a line naming it. That's decided for each call: the conversation and the journal keep the plain reference, so a later version of the agent that needs `vision` is shown the file. Text files go to any agent.
- **Outside data.** The rule an agent's system message gains for event data now covers files: any file under a line saying it comes from outside is data, not instructions. A turn gets it when its first messages carry files. A tool whose results may carry files should set `resultIsOutsideData`, so the rule is there from the turn's start.
- **What's made of a file, sent in its place.** A runtime may make an image of a photo for a model, or read a document's text, and send that in the file's place.
  - **For each call.** `FileBinding.admit` takes an optional call (`{ seesFiles }`). With it, each file carries its form for that one model call: `rendition` (an image, `FileRendition`) or `extracted` (its text, `FileExtract`). A turn asks for them before each model call, in the call's own copy only, so the journal and the conversation keep the plain reference, and a later call finds what's been made since. Without a call, `admit` is as before.
  - **Reading one.** `ModelCallInput.readFile` and `FileBinding.read` take the form to read (`FileForm`); without it, the file itself.
  - **Sending one.** `fileParts` sends a rendition as an image after the line naming the file, and a text in a `<file>` block naming the file, marked as read as text (and as cut, when it was cut at `FILE_LIMITS.textChars`), to any agent. Each form is held to the limits of what it is (a rendition to an image's, a text to a text file's), and counts its own bytes against the call's.
  - **`reading`** joins the reasons a file isn't shown: what's sent in its place isn't made yet.
- **A turn's memory charge** counts the bytes each call reads of its files (a form in a file's place, else the file), three times: the bytes, their base64 and the request body. `filesForCall` gives the files a call reads, decided as `fileParts` decides them, without reading any. `isReadable` says whether a call reads a file when it fits.
- **Room for a call's files.** A binding with `FileBinding.hold` gives each model call room for the files it reads, in the runtime's memory for files, before it reads any; the call releases it (`FileHold`) once it answers or fails. With no room in time, the call is sent with a `limit` line for each of them, so it reads none, and a later call shows them again.
  - **Two server settings** size that memory (runtime 0.4.0 on): `KINDGI_FILE_MEMORY_MIB`, 512 by default or a quarter of the server's memory when that's less, at least 35, the room one call's files take at their limit; and `KINDGI_FILE_CACHE_MIB`, the share of it that keeps files' bytes for later calls, half of it by default, 0 for none. A value out of range stops the boot, naming the variable.
- **Provenance.** A model call's node names the files it planned to read, by artifact id and sha256: at most what it read, since a provider's lower limit or a file found gone or changed can leave one out.
- **The API.** `ConversationMessage` gains an optional `files` (`FileValue[]`), and `GET /v1/conversations/{conversationId}/messages` returns it. The TypeScript client's `ConversationMessage` gains it too.
