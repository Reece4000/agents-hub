# Canvas and shared knowledge: implementation plan

This implements [CANVAS-KNOWLEDGE-PLAN.md](CANVAS-KNOWLEDGE-PLAN.md). Use its recommended defaults: agents update context autonomously with visible history, sections are flat, and completed tasks remain on the canvas with a hide filter. This is an implementation plan, not a change to the current running app.

## Build target

A developer can create a task at a canvas position, group it in a section, start work in a Session, and watch an integrated agent read linked notes and update progress. Completion records an outcome and evidence, updates or creates a concise codebase context note, and makes that learning retrievable to a second Session. Everything survives restart and direct repo file edits.

## Decisions that keep the implementation coherent

1. **One repo-local board store.** `.agents-hub/notes/<id>.md` holds note metadata in frontmatter and Markdown content. `.agents-hub/canvas.json` holds section geometry and note positions. A computed content hash is the revision sent to callers; it is not written into its own file. The in-memory search/graph index is derived and rebuildable. No database daemon is required.
2. **One mutation path.** Renderer IPC and agent-facing tools call the same board store interface. The store owns validation, optimistic revision checks, atomic writes, history, migration, indexing, and notifications. Direct external edits are watched and reindexed.
3. **Content and layout are separate.** Dragging a card writes only layout; editing its text writes only its note file. Section membership lives on the note and changes only through an explicit group action. This prevents a spatial move from overwriting agent-written content.
4. **Completion is an operation.** `completeTask` writes context changes before the final task state, using an operation ID and recoverable journal. A crash can leave a visible `knowledge pending` state, but cannot silently report captured knowledge that was never stored. Retries are idempotent.
5. **Tool access is capability-based.** A plain executable can always read repo files. A verified supported agent gets board summary/query/mutation tools and a launch briefing with the active task. Do not imply that arbitrary CLIs obey the board protocol.

## Module seams

| Module and location | Small interface callers use | Implementation it owns |
| --- | --- | --- |
| Shared model, `shared/board.ts` | `BoardNote`, `BoardSection`, `BoardCommand`, `BoardQuery`, result/error types | Schema version and discriminated types. Add `shared` to `tsconfig.json`. |
| Board store, `server/board-store.ts` | `load(repo)`, `query(repo, request)`, `apply(repo, command)`, `subscribe(repo, listener)`, `close()` | Path safety, parsing, per-file errors, migration, revision hashes, atomic writes, section/layout changes, derived search and backlinks, history/trash, watch with polling fallback. Internal helpers can live beside it; callers do not depend on them. |
| Completion logic, internal to board store | Invoked by `apply({type:'completeTask', ...})` | Evidence validation, context upserts, source links, operation journal, retry and recovery. It is not a second writer interface. |
| Desktop bridge, `server/service.ts`, `electron/main.ts`, `electron/preload.ts`, `src/bridge.ts` | `board:query`, `board:apply`, `onBoard` | Repo authorization, IPC transport, browser preview adapter, and forwarding store events. Terminal methods stay as they are. |
| Canvas, `src/BoardCanvas.tsx` plus focused child modules | Snapshot, selected note, dispatch command | Pointer/keyboard interaction, pan/zoom, visible cards and sections, focus and viewport recovery. No file parsing or migration logic in React. |
| Agent adapter, `server/board-agent.ts` and bundled CLI/MCP entry | Board summary, filtered list/search, read/related, update task, upsert context, complete task | Maps agent calls to board store queries/commands, bounds output size, validates active repo/task, and reports conflicts in agent-readable terms. |

Keep `server/tasks.ts` as legacy supervisor migration code until that roadmap is resolved; its “task” is a terminal resource identity, not a board task. Do not reuse it for note storage. Internal `RepoContext` and `selectedContexts` may remain during the UI rename; use `WorkspaceSession` as the new domain name only through a tested compatibility migration.

## File and command contracts

The note format has a version, stable ID, kind (`task | context | note`), title, timestamps, updater, optional section ID, and typed outbound links. Task metadata includes status (`open | working | blocked | done`), acceptance checks, assigned Session ID, outcome, and knowledge capture state. Context metadata includes subject, evidence references, source task IDs, and verification time. Markdown is the body; a parser rejects unsafe or malformed frontmatter without rewriting the file.

`canvas.json` contains a schema version, flat sections, positions keyed by stable note ID, and optional viewport defaults. Missing positions receive deterministic placement without modifying a note file. Search includes every valid note, including offscreen, collapsed, completed, and ungrouped notes. Results have stable sort order and pagination/output limits.

Every mutating command carries an operation ID; note edits carry an expected content revision. The store returns the new revision and emits one updated snapshot or delta. A revision mismatch returns the current version and preserves the caller's draft. A multi-note completion records its intent before writing, checks revisions again, writes context changes, then writes the task as done. Recovery replays only missing steps or surfaces a conflict. Never use last-write-wins for note text.

For history, save prior app/agent-written revisions under `.agents-hub/history/` and move deleted notes to `.agents-hub/trash/`. External direct edits are observed and attributed as external; capture the prior in-memory revision when possible. Git history may supplement this, but cannot be required because a selected folder may not be a Git repository.

## Work sequence

### 0. Contract and migration fixtures

- Add schema examples for each note kind, a section, links, evidence, and a completion journal entry.
- Freeze status mapping from old tickets: `backlog/planning/ready → open`, `in_progress/needs_testing → working`, `blocked → blocked`, `completed → done`. Keep old status in migration metadata.
- Mark migrated completed tasks as `captureState: legacy_unknown`; do not imply their historical learnings were captured or flood the board with new pending alerts.
- Test the current ticket files and workspace v2 Contexts as fixtures. Verify IDs, timestamps, text, acceptance checks, agent assignment, and Session references survive.
- Verify the first supported coding CLI's tool registration and packaged launch path before building a provider-specific adapter. Keep the board CLI contract independent of that provider.

**Exit:** schema and migration fixtures are accepted; a second run of the migration changes nothing.

### 1. Board store and reversible migration

- Implement the shared model and board store. Migrate `.agents-hub/tickets/AH-*.json` additively on first board open. Preserve ticket files and write a manifest of source hashes and destination IDs; do not delete originals. New notes become authoritative after the manifest commits.
- Detect edits to old ticket files after migration and surface them for import or comparison; do not silently discard work from an older agent still using the ticket path.
- Detect an existing destination ID or edited source during migration and report it without overwriting either file. A retry resumes safely after a crash.
- Implement per-file parse errors, derived query/index, links/backlinks, atomic writes, revision conflicts, history, trash, and directory watching with the existing polling fallback behavior.
- Add `board:query`, `board:apply`, and board events through the Electron bridge and an equivalent browser preview adapter.

**Exit:** create, edit, search, link, group, move, delete/restore, external edit, conflict, malformed file, and crash-retry cases pass at the store interface. Old ticket records still exist untouched.

### 2. Tasks canvas and Sessions rename

- Replace `src/TicketBoard.tsx` with `BoardCanvas` and child modules for card, section, detail panel, add menu, search, and viewport controls. Use DOM cards on a transformed plane so text, focus, and controls remain accessible.
- Right-click blank canvas opens Task, Note, Context, Section. A visible Add control and keyboard shortcut call the same action. Creating focuses the title; selecting a card opens a persistent side detail panel.
- Implement pan/zoom, drag, section resize/collapse, explicit membership on drop, fit/focus, search, filters, and empty/error/read-only states. Keep note content edits independent of drag updates; batch layout saves.
- Change user-visible Contexts to Sessions and Tickets to Tasks in `src/App.tsx`, `src/LaunchModal.tsx`, `src/FolderBrowser.tsx`, settings, empty states, README, and generated ticket guidance. Preserve existing IDs and terminal behavior. Rename internal fields only with a separate compatibility migration.

**Exit:** a keyboard-only user can create, edit, group, find, and restore a note. A pointer user can right-click and place it accurately. At narrow and wide window sizes, offscreen notes remain findable and cards remain readable.

### 3. Agent query and completion loop

- Build a board CLI with bounded JSON/text output, then a thin MCP adapter for an actually verified installed coding agent. Package the adapter with the desktop app and verify it works without a separately installed development toolchain.
- On “Work on task,” associate a Session, pass the active task ID and board location to its supported agent adapter, and offer a visible briefing for unsupported CLIs. The agent begins with board summary plus the task and linked context, then queries more as needed.
- Implement `updateTask`, `upsertContext`, and journaled `completeTask` through the board store. Require evidence or an explicit no-learning reason. Reuse an existing context note when the subject matches, and link changes back to the source task.
- Surface `knowledge pending`, conflict, unsupported adapter, interrupted completion, and no-durable-learning states in the UI. Show a readable history of agent changes and a restore action.

**Exit:** one agent completes a real task, updates context, and a new Session retrieves that context through search without a human copying it into the prompt. A killed process during completion recovers without duplicate facts or a false done state.

### 4. Scale, packaging, and release

- Check large and dense boards. Keep search and derived graph indexing outside React render; render only visible cards when density requires it. Dragging and terminal output must not trigger whole-board disk writes.
- Validate two concurrent agent writers, direct file edits, invalid links, symlink paths, read-only repos, packaged CLI/MCP launch, restart, and browser preview parity.
- Update `PRODUCT.md`, `README.md`, and the adjacent `.agents-hub` guide. Mark the old agentic roadmap as historical where it describes the former single-terminal product.

**Exit:** `npm test`, `npm run build`, packaged desktop smoke test, and the full two-Session learning loop pass. The old ticket board is no longer reachable in the UI, and no existing ticket or terminal group was lost.

## Verification matrix

| Risk | Required check |
| --- | --- |
| Migration loss or repeat | Fixture migration, second run no-op, interrupted migration recovery, ID collision, unchanged legacy files. |
| Agent overwrite | Two writers with the same expected revision; one succeeds, one gets a conflict and retains its text. |
| Incomplete knowledge capture | Kill between context write and task write; recover or show pending, never claim captured. |
| Retrieval gaps | Search by kind/status/section/file/link returns offscreen and collapsed notes; second Session finds prior learning. |
| Canvas usability | Right-click, Add button, keyboard creation, drag/drop membership, fit/focus, narrow window, screen reader names. |
| External edits | Valid update appears without reload; one malformed file leaves valid notes visible; repaired file returns. |
| Packaging | Bundled adapter launches in packaged macOS app with no dev server or repo `node_modules`. |

## Implementation order and dependencies

`schema + migration fixtures → board store → bridge → canvas → agent CLI/tool adapter → completion flow → packaged validation`

The first end-to-end demo should happen as soon as the store, a minimal canvas, and one agent adapter exist. Finish interaction polish and adapter breadth after that loop proves the data model. Do not ship the canvas as the final product while agent awareness or knowledge capture remains only a prompt convention.
