# Canvas task implementation plan

This plan covers the seven Tasks added on 24 September 2026. Six Tasks are marked done on the canvas; dictation remains working. The implementation below is present in the codebase as of 24 September 2026. Automated tests, a browser preview of the editor, and an arm64 macOS package build pass. Live microphone permission and spoken transcription still require a packaged-app check before the dictation Task can be completed. Claude/Cursor CLI launches also need runtime checks on machines with those CLIs installed.

## Brief and current state

**User and job.** A developer wants to capture and organize work directly on the canvas, attach visual evidence, dictate notes, and launch their preferred coding agent without learning a provider-specific setup.

**Desired outcome.** A card is the editing surface. Changes save without a Save button and remain safe across external edits. Images and dictated text become usable task context. Session launch and automatic canvas organization work with several installed agents. The organizer improves text coherence, links, grouping, and placement while treating user-authored messages as the source of truth.

**Consequence.** Editing a card changes a shared repo-local note; moving it changes repo-local layout. Uploading an image adds a repo-local asset. The organizer may edit note text, links, sections, kinds, and existing positions automatically, so each operation must preserve the user's original message and be inspectable and reversible. Launching an agent starts a local CLI process in the selected repository. [rule/name-object-scope-consequence, rule/preserve-user-input]

**Scope decisions.** "Native integration" means a first-class launch profile for each CLI, with provider-specific options, installation checks, and board handoff. It does not mean importing provider conversations or building a structured chat client. The current "detail modal" is actually a full-canvas document tab in `BoardCanvas.tsx`; the task is to replace that tab as the normal edit path. [rule/inline-before-modal, rule/preserve-mental-model]

## Delivery order

| Slice | Tasks | Why this order | Done when |
| --- | --- | --- | --- |
| 1. Card editing | AH-889FBF96E237, AH-A40BD615EEFB, AH-2212EF69454F | Autosave and drag behavior must be settled together before adding more inputs to cards. | Every note field can be edited on an expanded card, saved automatically, and moved by its header. |
| 2. First-class Sessions | AH-9201DE507D25 | A provider registry gives the organizer a clear execution path and removes single-provider launcher assumptions. | Codex, Claude Code, Cursor Agent, Shell, and custom CLI can be launched with their own valid options and clear missing-install errors. |
| 3. Image context | AH-EED6CFFD836E | Board assets need a durable repo-local path before briefings or model runs can reference them. | A task or note can show, remove, and reopen uploaded images; a task briefing identifies each image to the agent. |
| 4. Dictation | AH-BAD925F022D9 | The transcript should enter the same editor and autosave path as typing. | A user can record, review, and insert a transcript into a note, including permission and failure recovery. |
| 5. Canvas organizer | AH-058D0CA9299A | It consumes the stable note, image, link, layout, and provider contracts from earlier slices. | A configured lightweight model improves text and links and automatically arranges existing cards, with preserved user source, visible changes, and whole-operation undo. |

Slices 3 and 4 can be built independently after slice 1. Slice 5 can begin as a text-only organizer after slice 2, then include image context after slice 3.

## 1. Edit and move cards on the canvas

**Interaction.** A click selects a card and expands it in place; title, type, body, task status and acceptance, session, context evidence, links, history, and completion controls are available there. Keep the compact card for browsing. Expansion must remain usable at the minimum zoom and near viewport edges, with an internal scroll area when needed. Clicking a control must never start a pan or move. Keyboard focus enters the editor and returns to the card when it closes. [rule/inline-before-modal, rule/keyboard-complete-flow, rule/cover-reachable-states]

**Saving.** Use one draft controller for all fields. Mark a draft dirty immediately, debounce text writes, save discrete choices promptly, and flush pending edits on deselect, repo switch, and app close. Show Saving, Saved, Error, and Changed elsewhere states on the card. Do not clear a draft on failure. Keep the store's `expectedRevision` check; on conflict, present the current disk version and the preserved draft with reload/copy/retry choices. Serialize writes per note so an older response cannot replace newer keystrokes. Completion still uses the existing `completeTask` operation; changing status to Done cannot bypass knowledge capture. [rule/preserve-user-input, rule/cover-reachable-states, rule/error-states-recovery]

**Moving.** The whole top bar is the pointer drag target, except its buttons and type control. Use a movement threshold so a click can still select. Keep the existing position and section-drop semantics. Expose a keyboard move action or equivalent keyboard-complete alternative; update the hint text and grip affordance. Section headers keep their separate drag behavior. [rule/keyboard-complete-flow, rule/preserve-mental-model]

**Code seams.** Split `src/BoardCanvas.tsx` into card, editor/draft controller, and canvas interaction modules. Update `src/board.css` and geometry helpers: `cardHeight`, link anchors, viewport culling, fit-to-content, and section drop currently assume a fixed 172 px card. Prefer a stable collapsed size with an expanded overlay or measured geometry, rather than allowing expanded content to corrupt layout calculations. Keep note text in `server/board-store.ts` and positions in `canvas.json`.

**Checks.** Cover rapid typing plus external file edit, write failure, switching cards while saving, converting note kind, keyboard editing/movement, zoom and edge placement, drag versus click, and task completion. Verify the rendered flow at narrow and wide windows.

## 2. Provider-neutral Session launch

Replace the single-provider launcher with a typed provider registry. Add first-class Codex, Claude Code, and Cursor Agent profiles alongside Shell and Custom. Keep a migration reader for stored terminals using the current `TerminalKind`; new records should retain the chosen provider identity and provider-specific settings. A common launch contract should resolve an installed executable to an absolute path, validate arguments before creating the terminal, and spawn without a shell. [rule/cover-reachable-states]

The modal should first ask for the Session name and agent, then show only that agent's relevant options. Default to the provider's own model and permission settings unless the user changes them. Show installed/unavailable states and a useful repair path. Keep a custom executable plus argv editor for other agents. Avoid applying one provider's approval, trust, or model settings to another. Preserve a copyable board brief for every CLI and do not imply that MCP registration has happened automatically. [rule/smallest-intervention, rule/one-primary-action, rule/error-states-recovery]

**Code seams.** `src/LaunchModal.tsx`, `src/types.ts`, `server/service.ts`, `server/provider-profiles.ts`, `server/terminals.ts`, `server/store.ts`, and browser preview `src/bridge.ts`. The existing custom-profile UI says PATH commands are accepted, while `resolveCustomProfile` requires an absolute path and the service does not call it; unify validation and resolution before adding presets.

**Checks.** Test profile-to-argv mapping per provider, missing executable, invalid options, persisted Session migration, launch in the selected repo, and board briefing delivery. Verify in a packaged app, where GUI PATH commonly differs from the user's shell. The exact supported flags should be checked against the installed CLI version during implementation: [Codex CLI](https://developers.openai.com/codex/cli/reference), [Claude Code CLI](https://code.claude.com/docs/en/cli-reference), [Cursor Agent CLI](https://docs.cursor.com/en/cli/reference/parameters).

## 3. Durable images on Tasks and Notes

Add a board-owned attachment record to `BoardNote` and store validated image files under `.agents-hub/assets/` with generated names. Metadata holds a repository-relative path, display name, MIME type, size, and optional description. Keep binary assets separate from Markdown; never store base64 in note frontmatter. Use the existing IPC upload pattern in `server/service.ts` as a starting point, but board assets must live with the repository and survive an app reinstall. Restrict supported types and size, verify content rather than trusting the extension, and reject paths outside the board. [rule/cover-reachable-states]

The expanded card supports file picker, paste, drop, preview, description, and removal. A task briefing and agent board read expose the asset path and description, so a capable agent can inspect the image. Do not claim every arbitrary CLI can consume image pixels from a text path. Keep assets while referenced by current notes, history, or Trash; decide garbage collection only after those references are accounted for. [rule/preserve-user-input, rule/name-object-scope-consequence]

**Code seams.** `shared/board.ts`, `server/board-store.ts`, `server/service.ts`, `server/board-agent.ts`, `src/BoardCanvas.tsx`, and preview bridge. Add restart, missing-file, malformed-image, oversized-file, and agent-briefing checks.

## 4. Dictate into a note

Put a microphone action inside the expanded note editor. Recording is user initiated; show listening, processing, transcript-ready, denied, unavailable, and failed states. Insert the transcript at the cursor as editable text, then let the normal autosave path persist it. Stop the stream when the editor closes or the user cancels. Preserve the typed draft if transcription fails. Ask for microphone access at first use in context. [rule/value-before-interruption, rule/permission-benefit-first, rule/preserve-user-input, rule/cover-reachable-states]

Start with a short technical spike comparing on-device transcription integration and packaging. `whisper.cpp` is a candidate with macOS support and a local CLI, but a model and audio conversion must be bundled or installed deliberately; this is more than an npm dependency. Use one transcription service boundary so the engine can change without changing the editor. Electron microphone permission handling and the macOS usage description belong in the packaged app. [whisper.cpp](https://github.com/ggml-org/whisper.cpp/blob/master/README.md), [Electron media permissions](https://www.electronjs.org/docs/latest/api/session).

**Checks.** Test permission denial, empty/short audio, cancellation, transcription error, editor switch during recording, and transcript insertion. Verify packaged macOS behavior, including Intel and Apple Silicon if both builds remain supported.

## 5. Organize the canvas with a chosen small model

Store an organizer configuration per repository: provider/profile, model identifier, and a pause control. Automatic runs start when a valid model is configured. Reuse a supported local CLI adapter for a bounded one-shot run; do not assume a model ID such as `luna` or `haiku` is available in every installation. Feed it a bounded board snapshot with stable note IDs, the latest user-authored title/body, current organized presentation, links/sections, and optionally image references. Request structured proposed operations, then validate every ID, kind, link, section, and position in the board service before any write. Treat note contents as data, not instructions to the organizer. [rule/cover-reachable-states]

Keep the latest exact user-authored message as canonical provenance, separate from the organizer-edited presentation. Existing notes start with their current title/body as source; subsequent direct user edits replace that source. An organizer may reorder, format, clarify, and connect the user's statements, and may add clearly marked inferred context. It must not delete a user statement, change its meaning, turn uncertainty into fact, invent requirements or acceptance checks, or overwrite a later user correction. Store source and generated revisions with attribution, show a text diff and change log, and allow one-action restoration of the whole operation. If a proposed edit cannot preserve the source, leave it as a suggestion for the user. [rule/preserve-user-input, rule/name-object-scope-consequence]

After a note settles, coalesce changes and run the organizer automatically; also provide Organize canvas for an immediate run. It may update links/classification and rearrange previously hand-placed cards. Compute final geometry in the app from model-suggested relationships rather than accepting arbitrary pixel coordinates. Do not move a selected, dragged, or actively edited card mid-interaction; apply its pending placement when interaction ends. Make runs idempotent so unchanged input does not repeatedly shuffle the board. Never overwrite a dirty editor or a note whose revision changed since analysis. Group text, links, and layout changes under one operation ID with a whole-operation undo and a retry path for partial failures. [rule/preserve-user-input, rule/preserve-mental-model, rule/cover-reachable-states]

**Code seams.** New organizer service and provider adapter near `server/board-agent.ts`; shared proposal and provenance schema in `shared/board.ts`; board-store mutation for validated batch changes; settings, change log, diff, and undo UI in `BoardCanvas.tsx` or a focused child. The current `board-agent.ts` only exposes summary, search, read, task update, context upsert, and completion; it does not provide a batch organize operation.

**Checks.** Test preservation of original user statements, later user corrections, inferred-versus-authored text, repeated runs without layout jitter, active drag/edit deferral, malformed model output, hallucinated IDs, duplicate/cyclic links, stale revisions, concurrent editing, large boards, offline/unavailable provider, retry, and whole-operation undo. Measure input bounds and ensure offscreen and collapsed notes are included.

## Plan acceptance

- All seven Tasks keep their own status until their slice is implemented and verified.
- `npm test` and `npm run build` pass for each slice; new tests target storage, conflict, launch, and transcription boundaries rather than mirroring JSX.
- A packaged macOS smoke pass covers card editing, drag, images, microphone permission, each installed provider, and one organizer proposal.
- No feature may silently lose a draft, bypass task completion capture, or mutate unrelated repo files.

## Remaining assumption

The voice plan assumes local transcription. A cloud transcription option would add account, data transfer, and cost decisions.
