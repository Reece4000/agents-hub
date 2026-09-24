# Agent Hub: canvas and shared knowledge plan

## Product brief

**User and job.** A developer explores a repository with one or more coding agents. They want to capture tasks, questions, discoveries, and durable facts while work is happening, then find and reuse that knowledge in later work.

**Today.** Agent Hub has a seven-lane ticket board and terminal groups called Contexts. Tickets are repo-local JSON files, but a generic CLI agent has no guaranteed way to discover or query the whole board. Task outcomes do not feed a durable codebase knowledge layer.

**Desired outcome.** A spatial canvas becomes the repository's shared working memory. A developer can place and group notes freely. An integrated agent can discover relevant notes, update its task, and turn verified task learnings into concise codebase context. The next task can retrieve those learnings.

**Success signal.** In a fresh repository, a developer creates a task on the canvas, assigns it to a Session, the agent reads the task and linked context, updates progress, completes the task with evidence, updates a context note, and a second session retrieves that fact without being told its canvas location.

**Consequence.** Editing a note changes a repo-local shared record. Moving a note changes layout or section membership. Completing a task can change both the task and codebase context; those changes are visible, attributable, and reversible through history.

**Permissions.** A person who can write the repository can edit the board. An integrated agent acts within that same repository scope and its changes show an agent identity. A read-only repository still opens for browsing and searching, with write actions disabled and an explanation. [rule/cover-reachable-states]

**Non-goals.** The first release does not replace Git, own provider conversations, auto-document the entire repository, or infer durable facts without task evidence. It also does not require a separate graph database service.

**Assumptions.** Repository files remain the canonical shared store. Sections are flat in the first release. Agents may update codebase context autonomously, with provenance and reviewable history. These are proposed defaults, not yet accepted requirements.

## Product vocabulary

| User-facing term | Meaning | Current equivalent |
| --- | --- | --- |
| **Tasks** | The canvas and its task-bearing notes | Tickets board |
| **Sessions** | Named groups of one or more agent or shell terminals | Contexts |
| **Task** | A note describing work, with an owner, acceptance checks, and a small status | Ticket |
| **Codebase context** | A durable, evidence-backed fact about repository structure or behavior | New |
| **Note** | A thought, question, hypothesis, or reference that is not yet a task or durable fact | New |
| **Section** | A named spatial group on the canvas | New |
| **Link** | A typed relationship between notes, independent of layout | New |

“Session” means an Agent Hub terminal group. A provider's conversation or runtime session remains owned by that provider. A task can be associated with a Session without being the Session itself. The UI can rename the tab immediately; the storage migration must retain existing IDs and terminal state. [rule/preserve-mental-model]

## Core model

Use one **note** model with three initial kinds: `task`, `context`, and `note`. All have a stable ID, title, Markdown body, creator/updater, timestamps, revision, section ID, and links. Kind-specific fields stay small:

- `task`: `status` (`open`, `working`, `blocked`, `done`), acceptance checks, optional assigned Session/agent, outcome, and knowledge-capture state. Status is metadata on the card; it does not decide where the card lives. [rule/smallest-intervention]
- `context`: subject or scope, concise factual body, evidence references (file paths, symbols, tests, or commits), source task, and last verification timestamp. An agent should update an existing relevant fact before creating a near-duplicate. [rule/cover-reachable-states]
- `note`: freeform thinking. It can later be converted to a task or context note without changing its ID or links. [rule/preserve-mental-model]

Sections have an ID, name, position, size, and membership. Membership is explicit; geometric overlap alone does not silently reclassify a note. Links start with `relates_to`, `depends_on`, and `learned_from`. Backlinks are derived. A graph index supports search and traversal, while the canvas remains one view of that graph. This does not require a graph database engine for the first release. [rule/name-object-scope-consequence]

## Canvas interactions

1. Right-click empty space to add a Task, Note, Codebase context, or Section at the pointer. A visible **Add** control and keyboard shortcut open the same menu for keyboard and trackpad users. Right-clicking a note or section opens actions for that object. [rule/keyboard-complete-flow, rule/accessible-name-required]
2. Creating a note places it immediately and focuses its title. The card shows a short preview and kind; opening it reveals a persistent detail panel for writing, links, evidence, and task fields. Editing stays beside the canvas instead of interrupting it with a full-screen form. [rule/inline-before-modal]
3. Dragging moves a note. Dropping into a section asks for or shows explicit membership. Moving a section carries its members visually; collapsing a section preserves its content and links. Pan, zoom, fit to content, and “Find on canvas” make distant notes recoverable. [rule/preserve-mental-model]
4. Search and filters query all notes, including offscreen and collapsed ones. Results show type, section, and links; selecting a result focuses it on the canvas. A filter may dim unrelated notes so spatial context remains legible. [rule/cover-reachable-states]
5. Task cards show one small status badge. Status can be changed by a person or agent without moving the card. “Work on task” associates a Session and opens the task with its linked context in that Session's briefing. [rule/name-object-scope-consequence]
6. Delete moves notes or sections to recoverable trash. Deleting a section requires a clear choice to keep its notes ungrouped or move them to trash; there is no accidental cascade. [rule/destructive-proportional, rule/name-object-scope-consequence]

## Agent awareness contract

“Full awareness” means agents can discover and query the whole board, not that every note is pasted into every prompt. The standard contract should expose:

- `board_summary`: note counts by kind/status, sections, recently changed notes, and the active task.
- `list_notes` / `search_notes`: filters for kind, status, section, text, file/symbol reference, and linked note ID.
- `read_note` / `related_notes`: full body, metadata, backlinks, and evidence.
- `update_task`: status, outcome, blocker, or acceptance check with revision checking.
- `upsert_context`: create or revise a concise context fact with evidence and source task.
- `link_notes` and `complete_task`: relationships and the completion workflow below.

Make repo-local files and a small CLI/MCP adapter available to supported agents. A Session launch briefing tells an integrated agent where the board is, what task is active, and how to query it. A plain shell or arbitrary executable can read the files, but the app cannot guarantee that an arbitrary CLI will follow the workflow; the UI must show when knowledge capture is pending. [rule/cover-reachable-states]

The board index should provide progressive retrieval: summary first, targeted reads next. A large repository must not fill the agent's context window with every note. Queries use note content and metadata, never canvas position as a relevance signal. **Coverage gap (proposed `rule/queryable-shared-context`, new category: Agent integration):** every board item can be discovered by an agent independently of viewport position or UI filters.

## Task-to-knowledge loop

1. The agent reads the task and related context, marks it `working`, and links any newly discovered relevant notes.
2. While working, it records useful observations in the task outcome. Speculation remains a note or clearly labeled hypothesis; it does not become a codebase fact.
3. On completion, `complete_task` requires an outcome, acceptance results, and either one or more context changes **or** an explicit “no durable learning” reason. The agent revises existing context notes when possible, cites code/tests/commits, then marks the task `done`. This order avoids a “done” task whose learning was never written. [rule/cover-reachable-states]
4. Each promoted fact records source task, updater, evidence, and revision. A person can inspect the change from the task and restore a prior revision. If a direct file edit marks a task done without the capture step, show `knowledge pending` and allow the agent or person to finish it. [rule/name-object-scope-consequence, rule/error-states-recovery]
5. Later tasks retrieve context by subject, code references, links, and full-text search. They can update or mark a fact stale when the code changes. **Coverage gap (proposed `rule/provenance-for-agent-facts`, new category: Agent integration):** agent-written durable facts carry inspectable evidence and origin.

The default is autonomous updates with visible history, matching the requested agent behavior. There is no mandatory approval queue for every fact. Review is available when a fact appears wrong or stale. [rule/smallest-intervention]

## Storage and migration

- Keep the repository as the source of truth. Proposed format: `.agents-hub/notes/<stable-id>.md` with structured frontmatter and Markdown body. Store canvas positions and section geometry separately in `.agents-hub/canvas.json`; content edits must not conflict with a drag. An index is derived and rebuildable. [rule/preserve-mental-model]
- Use atomic writes and revision hashes for app and agent mutations. Detect and resolve conflicting edits; never silently replace another agent's text. Preserve malformed external files for repair and keep the last valid canvas visible with an error. [rule/preserve-user-input, rule/error-states-recovery]
- Migrate every existing `.agents-hub/tickets/AH-*.json` record to a Task note with the same ID and timestamps. Map `backlog/planning/ready` to `open`, `in_progress/needs_testing` to `working`, `blocked` to `blocked`, and `completed` to `done`; preserve the original stage in migration metadata. Create a backup or reversible migration manifest before changing files. [rule/preserve-mental-model]
- Rename Contexts to Sessions in the UI first. Keep persisted context IDs and compatibility readers until migration is verified. Avoid naming collisions with provider session IDs in code and documentation. [rule/preserve-mental-model]

## Reachable states and recovery

| State | Expected behavior |
| --- | --- |
| Empty repository | Show a small canvas seed with “Add a task or note” and a keyboard-accessible Add control. |
| One note or a dense board | Fit to content; keep cards readable; search and focus work regardless of zoom or section collapse. |
| External edit or concurrent agent write | Update the note or show a conflict with both versions; preserve unsaved input. |
| Invalid or missing note file | Keep valid notes visible, identify the file, and offer retry/repair. Broken links remain visible as missing targets. |
| Agent has no board integration | Show read-only/file instructions and `knowledge pending` when a task is marked done outside the completion contract. |
| Task blocked or work interrupted | Preserve outcome and current task association; status says why work stopped. |
| No durable learning | Permit completion with an explicit reason, visible in task history. |
| Deleted or offscreen content | Recover through trash, search, and fit/focus controls. |

These are release states, not later polish. [rule/cover-reachable-states, rule/empty-state-action, rule/error-states-recovery]

## Delivery slices

1. **Working memory:** rename navigation to Tasks and Sessions; add the note schema, reversible ticket migration, canvas placement, right-click/Add creation, sections, editing, search, and basic status. A user can work without a connected agent.
2. **One complete agent loop:** wire one supported coding agent to board summary/query/mutation tools. Start from a task, update status, complete with evidence, revise codebase context, and retrieve that fact in a new Session. Measure this path end to end before adding more adapters.
3. **Resilience and breadth:** add remaining agent adapters, conflict UI, history/trash, dense-board navigation, backlinks, and import/export. Validate keyboard and screen-reader completion, large boards, and concurrent file edits.

**Release gate:** demonstrate the success signal from the brief on a real repository with at least two Sessions, one interrupted task, and one externally edited note. Verify that the second agent finds the first task's learning without a manual prompt containing that fact.

## Decisions to confirm

1. Should codebase context be autonomously updated with history (recommended), or should each proposed fact wait for a person's approval?
2. Are flat sections enough initially, with links spanning sections, or is nesting essential to the way you organize work?
3. Should completed tasks remain on the canvas by default, or collapse into an archive that search still covers?
